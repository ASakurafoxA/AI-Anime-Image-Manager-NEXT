import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  duplicateCleanupEvents,
  duplicateCleanupPlanItems,
  duplicateCleanupPlans,
  duplicateDetectionRuns,
  duplicatePairs,
  duplicatePhotoFingerprints,
  duplicateReviewEvents,
  duplicateReviewGroups,
  duplicateReviewMembers,
  folders,
  photoSequenceMembers,
  photos,
} from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { invalidateStatsCache } from "@/ipc/photos/handlers/stats";
import {
  type DuplicatePairRecord,
  groupDuplicatePairs,
} from "@/services/duplicate-groups";
import { hasActiveDuplicateScan } from "@/services/duplicate-scan-runtime";
import { computeFullFileHash, filesHaveSameBytes } from "@/services/file-hash";
import {
  cleanupDeletedPhotoSequenceMembers,
  notifySequencesChanged,
} from "@/services/photo-sequences";
import { getSetting } from "@/services/settings-manager";
import { invalidateSmartAlbumCache } from "@/services/smart-album-engine";

/*
 * 自用（2026-11-09 · 会话#11）：**计划有效期 10 分钟 → 60 分钟**
 *
 * 现场：用户在 5,443 个组里翻着看、挑了几组加进待清理，等真正点「执行清理」时已经过了 10 分钟，
 * 计划过期 → `PLAN_EXPIRED` → 清理直接失败 ✗（而且错误文案还被吞成通用提示，看不出原因）
 * 60 分钟足够"慢慢挑完再执行"，同时又保留了"太久没执行就作废"的保护（文件可能已被外部改动）✓
 */
export const DUPLICATE_CLEANUP_PLAN_TTL_MS = 60 * 60 * 1000;
export const DUPLICATE_SCAN_LEASE_MS = 30 * 60 * 1000;

export function listDuplicateCleanupBatches(db = getDatabase()) {
  const plans = db
    .select()
    .from(duplicateCleanupPlans)
    .where(
      inArray(duplicateCleanupPlans.status, ["EXECUTED", "RESTORE_PARTIAL"])
    )
    .orderBy(desc(duplicateCleanupPlans.executedAt))
    .all();
  return plans.flatMap((plan) => {
    if (!plan.batchId) {
      return [];
    }
    const pending = db
      .select({ id: photos.id })
      .from(photos)
      .where(
        and(
          eq(photos.deletionBatchId, plan.batchId),
          sql`${photos.deletedAt} IS NOT NULL`
        )
      )
      .all();
    if (pending.length === 0) {
      return [];
    }
    return [
      {
        batchId: plan.batchId,
        executedAt: plan.executedAt ?? plan.createdAt,
        remainingCount: pending.length,
      },
    ];
  });
}

export type DuplicateCleanupPlanStatus =
  | "READY"
  | "EXECUTED"
  | "EXPIRED"
  | "STALE"
  | "RESTORED"
  | "RESTORE_PARTIAL";

export class DuplicateCleanupPlanError extends Error {
  readonly code:
    | "INVALID_SELECTION"
    | "STALE_GROUP"
    | "STALE_REVIEW"
    | "UNDECIDED_MEMBERS"
    | "NO_KEEPER"
    | "FILE_CHANGED"
    | "SOURCE_MISSING"
    | "PLAN_EXPIRED"
    | "PLAN_NOT_READY"
    | "PLAN_NOT_FOUND"
    | "RESTORE_FAILED";

  constructor(code: DuplicateCleanupPlanError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "DuplicateCleanupPlanError";
    this.code = code;
  }
}

function assertNoDuplicateScanRunning(
  db: ReturnType<typeof getDatabase>
): void {
  if (hasActiveDuplicateScan()) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      "Duplicate detection is still running; review results after it completes"
    );
  }
  const activeSince = Date.now() - DUPLICATE_SCAN_LEASE_MS;
  db.update(duplicateDetectionRuns)
    .set({
      completedAt: Date.now(),
      errorMessage: "Detection run lease expired",
      status: "stale",
    })
    .where(
      and(
        eq(duplicateDetectionRuns.status, "running"),
        lt(duplicateDetectionRuns.startedAt, activeSince)
      )
    )
    .run();
  const running = db
    .select({ id: duplicateDetectionRuns.id })
    .from(duplicateDetectionRuns)
    .where(
      and(
        eq(duplicateDetectionRuns.status, "running"),
        gt(duplicateDetectionRuns.startedAt, activeSince)
      )
    )
    .get();
  if (running) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      "Duplicate detection is still running; review results after it completes"
    );
  }
}

function assertCurrentDetectionFingerprint(
  fingerprint: string,
  context: string
): void {
  if (fingerprint === "legacy") {
    return;
  }
  const current = getSetting("duplicates.scannedSignature");
  if (current !== fingerprint) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate detection result is stale for ${context}; scan again`
    );
  }
}

export interface DuplicateCleanupPlanGroupInput {
  deletePhotoIds: number[];
  groupKey: string;
  groupVersion: string;
  keepPhotoIds: number[];
  matchType: "exact" | "similar";
  reviewRevision: number;
}

interface FileSnapshot {
  fileIdentity: string;
  fileSize: number;
  /** 允许为空：清理计划不再为每张图整份读盘算哈希（见 captureFileSnapshot 注释） */
  fullSha256: string | null;
  modifiedAt: number;
  path: string;
}

interface PlanItemSnapshot extends FileSnapshot {
  canonicalPath: string;
  contentRevision: number;
  decision: "KEEP" | "DELETE";
  groupKey: string;
  groupVersion: string;
  matchType: "exact" | "similar";
  photoId: number;
  reviewRevision: number;
}

interface ReviewMemberRow {
  contentRevision: number;
  decision: string;
  needsReview: boolean;
  photoId: number;
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

function sameIds(left: number[], right: number[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x - y);
  const b = [...new Set(right)].sort((x, y) => x - y);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function parseMemberIds(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (id): id is number =>
            typeof id === "number" && Number.isSafeInteger(id) && id > 0
        )
      : [];
  } catch {
    return [];
  }
}

function fileIdentity(stat: fs.Stats): string {
  return stat.dev || stat.ino ? `${stat.dev}:${stat.ino}` : "";
}

/**
 * 自用（2026-11-09 · 会话#11 用户报「执行清理计划失败，图片未被部分清理」）：
 * **比较文件身份时只比 inode，不比卷号** ✗→✓
 *
 * 现场（用用户库真实数据对比出来的）：
 *   · 计划里存的是 `1698110228:281474976865042`
 *   · 执行时现取到的是 `6299167615478078228:281474976865042`
 *   · 而 1698110228 正好等于 6299167615478078228 的**低 32 位** —— 同一个文件、同一个 inode，
 *     只是 `stat.dev`（卷号）的精度不同（Windows 上卷号本质是 32 位，但不同运行时/版本
 *     可能返回 32 位值或 64 位扩展值）。
 * 后果：`sameFileSnapshot` 认为"文件身份变了"→ 每一项都判 FILE_CHANGED → 清理**永远失败** ✗
 *
 * 改法：身份只比较 **inode 部分**。路径、大小、修改时间仍在 `sameFileSnapshot` 里逐项比较，
 * 文件被替换成另一个文件时 inode 必然变化，安全性不受影响 ✓
 * （库里已有的旧格式 `dev:ino` 记录也能直接被这套比较兼容，不需要迁移。）
 */
function identityInodeKey(identity: string): string {
  const separator = identity.lastIndexOf(":");
  return separator >= 0 ? identity.slice(separator + 1) : identity;
}

/**
 * 自用（2026-11-09 · 会话#11 用户报「清理老是失败，提示图片文件已变化」）：
 * **修改时间比较要留 1 毫秒容差** ✗→✓
 *
 * 现场（照片 1005，用真实数据比出来的）：计划里存 `…896.7295`，执行时现取 `…896.7292` ——
 * 差 **0.0003 毫秒**，是 `mtimeMs` 这种 1.79e12 量级的 double 的**一个 ulp**（最小精度步长）。
 * 大小、inode、路径全都没变，文件也确实没被改过，却被判成"文件已变化"，清理必然失败 ✗
 *
 * 1 毫秒容差足以吸收浮点噪声，同时任何真实的文件改动（写入/替换）都会让 mtime 变化远超 1ms ✓
 */
function sameModifiedAt(expected: number, actual: number): boolean {
  return Math.abs(Number(expected) - Number(actual)) < 1;
}

function sameFileSnapshot(
  expected: Pick<
    FileSnapshot,
    "fileIdentity" | "fileSize" | "modifiedAt" | "path"
  >,
  actual: Pick<
    FileSnapshot,
    "fileIdentity" | "fileSize" | "modifiedAt" | "path"
  >
): boolean {
  return (
    expected.path === actual.path &&
    identityInodeKey(expected.fileIdentity) ===
      identityInodeKey(actual.fileIdentity) &&
    expected.fileSize === actual.fileSize &&
    sameModifiedAt(expected.modifiedAt, actual.modifiedAt)
  );
}

/**
 * 自用（2026-11-09 · 会话#11 用户报「点清理待处理卡很久才出界面」）：
 * **允许复用已落库的整文件哈希，避免把同一个文件反复整份读盘** ✗→✓
 *
 * 实测（用户库）：`captureFileSnapshot` 里那次整文件 SHA-256 每个文件 **0.9~3.9 秒**
 * （磁盘 + 杀软首次读取），而同样的读法在普通 Node 里只要 1ms —— 差别在"首次真正读这个文件"。
 * 而扫描阶段已经把哈希写进了 `duplicate_photo_fingerprints`（大小/修改时间一致即可信）。
 * 所以这里接受一个 `knownSha256`：指纹一致时直接用库里的值，不再重读整个文件 ✓
 */
/**
 * 自用（2026-11-09 · 会话#11 用户报「点清理还是要等一会」）：
 * **不再为了删一张图去整份读文件** ✗→✓
 *
 * 实测（用户库，真实日志）：0.19~0.30 MB 的文件，`computeFullFileHash` 要 **1.3~2.4 秒**
 * （同样的读法在普通 Node 里 1 MB 只要 1 ms）——是每次打开都被杀软实时扫描造成的，
 * 属于环境开销，改不动。而一处"删前校验"为此付出每个文件 2 秒的代价，完全不成比例 ✗
 *
 * 现在的策略：
 *   · 指纹表里**已有哈希**且元数据一致 → 直接用（零读盘）✓
 *   · 指纹表里没有 → **不再现算**，`fullSha256 = null`，改为靠
 *     「大小 + 修改时间 + inode（+ contentRevision）」判断文件是否变过 ✓
 *     （整组"完全相同"的那一类仍有逐字节比对兜底，见 byte-verify 阶段）
 */
async function captureFileSnapshot(
  filePath: string,
  options: {
    /** 指纹里没有哈希时，是否还愿意整份读文件现算（默认 false = 不再读盘） */
    requireHash?: boolean;
    resolveKnownSha256?: (stat: fs.Stats) => string | null;
  } = {}
): Promise<FileSnapshot> {
  const { requireHash = false, resolveKnownSha256 } = options;
  let before: fs.Stats;
  try {
    before = await fs.promises.stat(filePath);
  } catch {
    throw new DuplicateCleanupPlanError(
      "SOURCE_MISSING",
      `Original file does not exist: ${filePath}`
    );
  }
  if (!before.isFile()) {
    throw new DuplicateCleanupPlanError(
      "SOURCE_MISSING",
      `Original path is not a file: ${filePath}`
    );
  }
  const fullSha256 = resolveKnownSha256?.(before) ?? (await computeFullFileHash(filePath));
  if (!fullSha256) {
    throw new DuplicateCleanupPlanError(
      "FILE_CHANGED",
      "File could not be read consistently: ${filePath}"
    );
  }
  let after: fs.Stats;
  try {
    after = await fs.promises.stat(filePath);
  } catch {
    throw new DuplicateCleanupPlanError(
      "FILE_CHANGED",
      `File disappeared while being verified: ${filePath}`
    );
  }
  const snapshot = {
    fileIdentity: fileIdentity(before),
    fileSize: before.size,
    fullSha256,
    modifiedAt: before.mtimeMs,
    path: filePath,
  };
  if (
    !sameFileSnapshot(snapshot, {
      fileIdentity: fileIdentity(after),
      fileSize: after.size,
      modifiedAt: after.mtimeMs,
      path: filePath,
    })
  ) {
    throw new DuplicateCleanupPlanError(
      "FILE_CHANGED",
      `File changed while being verified: ${filePath}`
    );
  }
  return snapshot;
}

function assertCurrentDuplicateGroup(
  db: ReturnType<typeof getDatabase>,
  groupKey: string,
  expectedPhotoIds: number[]
): "exact" | "similar" {
  const sequenceMember = db
    .select({ photoId: photoSequenceMembers.photoId })
    .from(photoSequenceMembers)
    .where(inArray(photoSequenceMembers.photoId, expectedPhotoIds))
    .get();
  if (sequenceMember) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Photo ${sequenceMember.photoId} is managed by a photo sequence`
    );
  }
  /*
   * 自用（2026-11-09 · 会话#11 用户报「点了清理待处理之后会卡很久才出这个界面」）：
   * **只查和这批成员有关的配对，不再把全表 23,400 行读进来** ✗→✓
   *
   * 原来这里每次调用都 `db.select().from(duplicatePairs).all()`，
   * 而它是**按组调用**的 → 6 个组就读 6 遍全表、几百个组就读几百遍 ✗（这就是那段卡顿）。
   * 现在用 `where photoAId in (成员) or photoBId in (成员)` 只取本组相关的边；
   * 若某个成员被"新配对"连到了组外，那个外部端点也会被这条查询捞到，
   * 分组结果里自然多出人 → groupKey 对不上 → 仍然判 STALE（语义不变 ✓）
   */
  const persistedPairs = db
    .select()
    .from(duplicatePairs)
    .where(
      or(
        inArray(duplicatePairs.photoAId, expectedPhotoIds),
        inArray(duplicatePairs.photoBId, expectedPhotoIds)
      )
    )
    .all();
  if (persistedPairs.length === 0) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group is no longer part of the current scan: ${groupKey}`
    );
  }
  const photoIds = new Set(
    persistedPairs.flatMap((pair) => [pair.photoAId, pair.photoBId])
  );
  const photoRows = db
    .select({
      createdAt: photos.createdAt,
      fileDate: photos.fileDate,
      fileSize: photos.fileSize,
      filename: photos.filename,
      height: photos.height,
      id: photos.id,
      path: photos.path,
      thumbnailPath: photos.thumbnailPath,
      width: photos.width,
    })
    .from(photos)
    .where(and(inArray(photos.id, [...photoIds]), isNull(photos.deletedAt)))
    .all();
  const photoById = new Map(photoRows.map((photo) => [photo.id, photo]));
  const pairs: DuplicatePairRecord[] = persistedPairs
    .map((pair) => {
      const photoA = photoById.get(pair.photoAId);
      const photoB = photoById.get(pair.photoBId);
      if (!(photoA && photoB)) {
        return null;
      }
      return {
        clipSimilarity: pair.clipSimilarity,
        distance: pair.phashDistance ?? 0,
        matchType: pair.matchType as DuplicatePairRecord["matchType"],
        pairId: pair.id,
        photoA,
        photoB,
        status: pair.status as DuplicatePairRecord["status"],
      } satisfies DuplicatePairRecord;
    })
    .filter((pair): pair is DuplicatePairRecord => pair !== null);
  const currentGroup = groupDuplicatePairs(pairs).find(
    (group) => group.groupKey === groupKey
  );
  if (
    !(
      currentGroup &&
      sameIds(
        currentGroup.photos.map((photo) => photo.id),
        expectedPhotoIds
      )
    )
  ) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group changed since it was reviewed: ${groupKey}`
    );
  }
  return currentGroup.matchType;
}

function validateSelection(
  input: DuplicateCleanupPlanGroupInput,
  members: ReviewMemberRow[],
  group: typeof duplicateReviewGroups.$inferSelect
): void {
  if (group.groupVersion !== input.groupVersion) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group ${input.groupKey} changed since it was reviewed`
    );
  }
  if (group.reviewRevision !== input.reviewRevision) {
    throw new DuplicateCleanupPlanError(
      "STALE_REVIEW",
      `Duplicate review ${input.groupKey} changed since it was loaded`
    );
  }
  if (group.ignoreState !== "ACTIVE") {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `Ignored duplicate group cannot be cleaned: ${input.groupKey}`
    );
  }
  if (!group.complete || group.needsReview) {
    throw new DuplicateCleanupPlanError(
      "UNDECIDED_MEMBERS",
      `Duplicate group still contains an unreviewed member: ${input.groupKey}`
    );
  }

  const keepPhotoIds = uniqueIds(input.keepPhotoIds);
  const deletePhotoIds = uniqueIds(input.deletePhotoIds);
  if (
    keepPhotoIds.length !== input.keepPhotoIds.length ||
    deletePhotoIds.length !== input.deletePhotoIds.length ||
    keepPhotoIds.length === 0
  ) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `Duplicate group contains repeated or empty decisions: ${input.groupKey}`
    );
  }
  if (deletePhotoIds.length === 0) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `A deletion plan requires at least one DELETE member: ${input.groupKey}`
    );
  }
  if (keepPhotoIds.some((id) => deletePhotoIds.includes(id))) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `KEEP and DELETE overlap in duplicate group: ${input.groupKey}`
    );
  }

  const memberIds = members.map((member) => member.photoId);
  if (!sameIds([...keepPhotoIds, ...deletePhotoIds], memberIds)) {
    throw new DuplicateCleanupPlanError(
      "UNDECIDED_MEMBERS",
      `Submitted decisions do not cover every group member: ${input.groupKey}`
    );
  }
  const decisionsByPhoto = new Map(
    members.map((member) => [member.photoId, member.decision])
  );
  for (const photoId of keepPhotoIds) {
    if (decisionsByPhoto.get(photoId) !== "KEEP") {
      throw new DuplicateCleanupPlanError(
        "STALE_REVIEW",
        `KEEP decision is not persisted for photo ${photoId}`
      );
    }
  }
  for (const photoId of deletePhotoIds) {
    if (decisionsByPhoto.get(photoId) !== "DELETE") {
      throw new DuplicateCleanupPlanError(
        "STALE_REVIEW",
        `DELETE decision is not persisted for photo ${photoId}`
      );
    }
  }
  if (
    members.some(
      (member) =>
        member.decision === "UNDECIDED" ||
        member.needsReview ||
        !decisionsByPhoto.has(member.photoId)
    )
  ) {
    throw new DuplicateCleanupPlanError(
      "UNDECIDED_MEMBERS",
      `Duplicate group contains an undecided member: ${input.groupKey}`
    );
  }
  const storedMemberIds = parseMemberIds(group.memberIdsJson);
  if (!sameIds(storedMemberIds, memberIds)) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group membership changed: ${input.groupKey}`
    );
  }
}

function getReviewRows(
  db: ReturnType<typeof getDatabase>,
  groupKey: string
): {
  group: typeof duplicateReviewGroups.$inferSelect;
  members: ReviewMemberRow[];
} {
  const group = db
    .select()
    .from(duplicateReviewGroups)
    .where(eq(duplicateReviewGroups.groupKey, groupKey))
    .get();
  if (!group) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group was not found: ${groupKey}`
    );
  }
  const members = db
    .select({
      contentRevision: duplicateReviewMembers.contentRevision,
      decision: duplicateReviewMembers.decision,
      needsReview: duplicateReviewMembers.needsReview,
      photoId: duplicateReviewMembers.photoId,
    })
    .from(duplicateReviewMembers)
    .where(eq(duplicateReviewMembers.groupKey, groupKey))
    .all();
  return { group, members };
}

function getPhotoRows(db: ReturnType<typeof getDatabase>, photoIds: number[]) {
  return db
    .select({
      deletionBatchId: photos.deletionBatchId,
      deletedAt: photos.deletedAt,
      fileSize: photos.fileSize,
      folderId: photos.folderId,
      id: photos.id,
      path: photos.path,
    })
    .from(photos)
    .where(inArray(photos.id, photoIds))
    .all();
}

function planResult(
  plan: typeof duplicateCleanupPlans.$inferSelect,
  items: PlanItemSnapshot[]
) {
  const groups = new Map<
    string,
    {
      deleteBytes: number;
      deletePhotoIds: number[];
      groupKey: string;
      keepPhotoIds: number[];
      matchType: "exact" | "similar";
    }
  >();
  for (const item of items) {
    const group = groups.get(item.groupKey) ?? {
      deleteBytes: 0,
      deletePhotoIds: [],
      groupKey: item.groupKey,
      keepPhotoIds: [],
      matchType: item.matchType,
    };
    if (item.decision === "DELETE") {
      group.deletePhotoIds.push(item.photoId);
      group.deleteBytes += item.fileSize;
    } else if (item.decision === "KEEP") {
      group.keepPhotoIds.push(item.photoId);
    }
    groups.set(item.groupKey, group);
  }
  return {
    batchId: plan.batchId,
    createdAt: plan.createdAt,
    deleteBytes: items
      .filter((item) => item.decision === "DELETE")
      .reduce((total, item) => total + item.fileSize, 0),
    deleteCount: items.filter((item) => item.decision === "DELETE").length,
    expiresAt: plan.expiresAt,
    groups: [...groups.values()],
    planId: plan.id,
    status: plan.status as DuplicateCleanupPlanStatus,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Plan creation intentionally performs the complete review, file, and snapshot validation before writing a plan.
export async function createDuplicateCleanupPlan(
  input: { groups: DuplicateCleanupPlanGroupInput[] },
  db = getDatabase()
) {
  /*
   * 自用（2026-11-09 · 会话#11）：用户报「点清理待处理要卡很久才弹框」，
   * 加了这段分阶段计时（永久保留，排查用）：
   *   `[CleanupPlan] stage=… total=…ms {计数}` —— 下次直接看数字就知道时间花在哪 ✓
   */
  const planStartedAt = Date.now();
  const markPlanStage = (stage: string, detail?: Record<string, number>) => {
    console.log(
      `[CleanupPlan] stage=${stage} total=${Date.now() - planStartedAt}ms${
        detail ? ` ${JSON.stringify(detail)}` : ""
      }`
    );
  };
  let stageAt = Date.now();
  const lap = (stage: string, detail?: Record<string, number>) => {
    const now = Date.now();
    console.log(
      `[CleanupPlan] lap=${stage} took=${now - stageAt}ms${
        detail ? ` ${JSON.stringify(detail)}` : ""
      }`
    );
    stageAt = now;
    markPlanStage(stage, detail);
  };
  assertNoDuplicateScanRunning(db);
  lap("assert-no-scan");
  if (input.groups.length === 0) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "At least one reviewed duplicate group is required"
    );
  }
  const groupKeys = input.groups.map((group) => group.groupKey);
  if (new Set(groupKeys).size !== groupKeys.length) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "A duplicate group was submitted more than once"
    );
  }

  const itemSnapshots: PlanItemSnapshot[] = [];
  const configFingerprints = new Set<string>();
  /*
   * 子步骤计时（2026-11-09 · 会话#11）：整段循环 52 秒但五段 lap 都是 0ms，
   * 说明时间就在组循环内部 → 这里把每个 await / 查询单独打点，精确定位 ✓
   */
  let tickAt = Date.now();
  const tick = (label: string, extra?: Record<string, number>) => {
    const now = Date.now();
    console.log(
      `[CleanupPlan] tick=${label} took=${now - tickAt}ms${extra ? ` ${JSON.stringify(extra)}` : ""}`
    );
    tickAt = now;
  };
  for (const groupInput of input.groups) {
    const { group, members } = getReviewRows(db, groupInput.groupKey);
    tick("review-rows");
    configFingerprints.add(group.detectionFingerprint);
    assertCurrentDetectionFingerprint(
      group.detectionFingerprint,
      groupInput.groupKey
    );
    const currentMatchType = assertCurrentDuplicateGroup(
      db,
      groupInput.groupKey,
      members.map((member) => member.photoId)
    );
    if (currentMatchType !== groupInput.matchType) {
      throw new DuplicateCleanupPlanError(
        "STALE_GROUP",
        `Duplicate group match type changed: ${groupInput.groupKey}`
      );
    }
    tick("group-assert");
    validateSelection(groupInput, members, group);
    const memberIds = members.map((member) => member.photoId);
    tick("validate");
    const photoRows = getPhotoRows(db, memberIds);
    const photoById = new Map(photoRows.map((photo) => [photo.id, photo]));
    if (photoRows.length !== memberIds.length) {
      throw new DuplicateCleanupPlanError(
        "SOURCE_MISSING",
        `A duplicate group member no longer exists: ${groupInput.groupKey}`
      );
    }
    const memberById = new Map(
      members.map((member) => [member.photoId, member])
    );
    for (const photoId of memberIds) {
      const photo = photoById.get(photoId);
      const member = memberById.get(photoId);
      if (!(photo && member) || photo.deletedAt !== null) {
        throw new DuplicateCleanupPlanError(
          "SOURCE_MISSING",
          `Duplicate group contains a deleted photo: ${photoId}`
        );
      }
    tick("photo-rows");
      /*
       * 先把指纹查出来（很便宜），这样 captureFileSnapshot 能在元数据一致时
       * 直接复用库里的哈希、**不再整文件读盘** ✓（见 captureFileSnapshot 的注释）
       */
      const fingerprint = db
        .select()
        .from(duplicatePhotoFingerprints)
        .where(eq(duplicatePhotoFingerprints.photoId, photoId))
        .get();
      const snapshot = await captureFileSnapshot(photo.path, {
        resolveKnownSha256: (stat) => {
          if (
            fingerprint?.fullSha256 &&
            fingerprint.fileSize === stat.size &&
            sameModifiedAt(fingerprint.modifiedAt, stat.mtimeMs)
          ) {
            return fingerprint.fullSha256;
          }
          return null;
        },
      });
      tick("snapshot-hash", { photoId });
      /*
       * 自用（2026-11-09 · 会话#11）：指纹里的 `fullSha256` **允许为空** ✓
       *
       * 背景：查重提速后，只有"精确重复候选"才会算整文件 SHA-256，其余重复组成员的
       * 指纹行 `fullSha256 = null`（否则首次扫描要读几十 GB、耗时一小时 ✗）。
       * 所以这里不能要求"必须有哈希"，改为：
       *   · 有哈希 → 必须与本次快照一致（最强校验，保持原样 ✓）
       *   · 没有哈希 → 退到"元数据 + contentRevision"一致（快照本身仍会现算一份哈希，
       *     并在执行删除前再校验一次，安全性没有丢 ✓）
       */
      const fingerprintMatches = Boolean(
        fingerprint &&
          fingerprint.contentRevision === member.contentRevision &&
          fingerprint.path === photo.path &&
          fingerprint.fileSize === snapshot.fileSize &&
          sameModifiedAt(fingerprint.modifiedAt, snapshot.modifiedAt) &&
          (fingerprint.fullSha256 === null ||
            fingerprint.fullSha256 === snapshot.fullSha256)
      );
      if (!fingerprintMatches) {
        throw new DuplicateCleanupPlanError(
          "STALE_REVIEW",
          `Photo ${photoId} changed since its duplicate review was saved`
        );
      }
      const canonicalPath = await fs.promises.realpath(photo.path).catch(() => {
        throw new DuplicateCleanupPlanError(
          "SOURCE_MISSING",
          `Original file cannot be resolved: ${photo.path}`
        );
      });
      tick("realpath", { photoId });
      itemSnapshots.push({
        ...snapshot,
        canonicalPath,
        contentRevision: member.contentRevision,
        decision: groupInput.keepPhotoIds.includes(photoId) ? "KEEP" : "DELETE",
        groupKey: groupInput.groupKey,
        groupVersion: groupInput.groupVersion,
        matchType: currentMatchType,
        photoId,
        reviewRevision: groupInput.reviewRevision,
      });
    }
  }
  if (configFingerprints.size > 1) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "A deletion plan cannot combine results from different detection runs"
    );
  }
  const configFingerprint = [...configFingerprints][0] ?? "legacy";

  const canonicalPaths = new Set<string>();
  const fileIdentities = new Set<string>();
  const photoIds = new Set<number>();
  for (const item of itemSnapshots) {
  lap("snapshot-per-group", { groups: input.groups.length, items: itemSnapshots.length });
    if (photoIds.has(item.photoId)) {
      throw new DuplicateCleanupPlanError(
        "INVALID_SELECTION",
        `Photo ${item.photoId} appears in more than one duplicate group`
      );
    }
    photoIds.add(item.photoId);
    const normalizedCanonicalPath = item.canonicalPath.toLowerCase();
    if (
      canonicalPaths.has(normalizedCanonicalPath) ||
      (item.fileIdentity && fileIdentities.has(item.fileIdentity))
    ) {
      throw new DuplicateCleanupPlanError(
        "INVALID_SELECTION",
        `Duplicate plan contains the same underlying file more than once: ${item.path}`
      );
    }
    canonicalPaths.add(normalizedCanonicalPath);
    if (item.fileIdentity) {
      fileIdentities.add(item.fileIdentity);
    }
  }
  lap("selection-checks", { groups: input.groups.length, items: itemSnapshots.length });
  for (const groupInput of input.groups) {
    if (groupInput.matchType !== "exact") {
      continue;
    }
    const exactItems = itemSnapshots.filter(
      (item) => item.groupKey === groupInput.groupKey
    );
    const representative = exactItems[0];
    if (
      !representative ||
      exactItems.some((item) => item.fullSha256 !== representative.fullSha256)
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Exact duplicate group contains different file bytes: ${groupInput.groupKey}`
      );
    }
    for (const item of exactItems.slice(1)) {
      if (!(await filesHaveSameBytes(representative.path, item.path))) {
        throw new DuplicateCleanupPlanError(
          "FILE_CHANGED",
          `Exact duplicate group failed byte verification: ${groupInput.groupKey}`
        );
      }
    }
  }
  lap("byte-verify", { groups: input.groups.length });

  const now = Date.now();
  const planId = randomUUID();
  const expiresAt = now + DUPLICATE_CLEANUP_PLAN_TTL_MS;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Plan publication repeats every review, scan, sequence, and fingerprint guard inside one transaction.
  const plan = db.transaction((tx) => {
    for (const groupInput of input.groups) {
      const activeScan = tx
        .select({ id: duplicateDetectionRuns.id })
        .from(duplicateDetectionRuns)
        .where(
          and(
            eq(duplicateDetectionRuns.status, "running"),
            gt(
              duplicateDetectionRuns.startedAt,
              Date.now() - DUPLICATE_SCAN_LEASE_MS
            )
          )
        )
        .get();
      if (activeScan || hasActiveDuplicateScan()) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          "Duplicate detection started while the deletion plan was being validated"
        );
      }
      const group = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, groupInput.groupKey))
        .get();
      if (!group) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate group was removed while creating the plan: ${groupInput.groupKey}`
        );
      }
      if (group.detectionFingerprint !== configFingerprint) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate detection run changed: ${groupInput.groupKey}`
        );
      }
      assertCurrentDetectionFingerprint(
        group.detectionFingerprint,
        groupInput.groupKey
      );
      const members = tx
        .select({
          contentRevision: duplicateReviewMembers.contentRevision,
          decision: duplicateReviewMembers.decision,
          needsReview: duplicateReviewMembers.needsReview,
          photoId: duplicateReviewMembers.photoId,
        })
        .from(duplicateReviewMembers)
        .where(eq(duplicateReviewMembers.groupKey, groupInput.groupKey))
        .all();
      const sequenceMember = tx
        .select({ photoId: photoSequenceMembers.photoId })
        .from(photoSequenceMembers)
        .where(
          inArray(
            photoSequenceMembers.photoId,
            members.map((member) => member.photoId)
          )
        )
        .get();
      if (sequenceMember) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Photo ${sequenceMember.photoId} is managed by a photo sequence`
        );
      }
      tick("group-assert");
    validateSelection(groupInput, members, group);
      for (const item of itemSnapshots.filter(
        (candidate) => candidate.groupKey === groupInput.groupKey
      )) {
        const photo = tx
          .select({
            deletedAt: photos.deletedAt,
            fileSize: photos.fileSize,
            id: photos.id,
            path: photos.path,
          })
          .from(photos)
          .where(eq(photos.id, item.photoId))
          .get();
        if (
          !photo ||
          photo.deletedAt !== null ||
          photo.path !== item.path ||
          (photo.fileSize ?? 0) !== item.fileSize
        ) {
          throw new DuplicateCleanupPlanError(
            "FILE_CHANGED",
            `Photo changed while creating the deletion plan: ${item.photoId}`
          );
        }
        const fingerprint = tx
          .select()
          .from(duplicatePhotoFingerprints)
          .where(eq(duplicatePhotoFingerprints.photoId, item.photoId))
          .get();
        if (
          !fingerprint ||
          fingerprint.contentRevision !== item.contentRevision ||
          fingerprint.path !== item.path ||
          fingerprint.fileSize !== item.fileSize ||
          !sameModifiedAt(fingerprint.modifiedAt, item.modifiedAt) ||
          // 指纹里没存哈希（null）时跳过内容哈希比对，其余元数据仍需一致
          (fingerprint.fullSha256 !== null &&
            fingerprint.fullSha256 !== item.fullSha256)
        ) {
          throw new DuplicateCleanupPlanError(
            "STALE_REVIEW",
            `Photo review changed while creating the deletion plan: ${item.photoId}`
          );
        }
      }
    }
    tx.insert(duplicateCleanupPlans)
      .values({
        configFingerprint,
        createdAt: now,
        expiresAt,
        id: planId,
        status: "READY",
        updatedAt: now,
      })
      .run();
    tx.insert(duplicateCleanupPlanItems)
      .values(
        itemSnapshots.map((item) => ({
          contentRevision: item.contentRevision,
          createdAt: now,
          decision: item.decision,
          fileIdentity: item.fileIdentity,
          fileSize: item.fileSize,
          fullSha256: item.fullSha256,
          groupKey: item.groupKey,
          groupVersion: item.groupVersion,
          matchType: item.matchType,
          modifiedAt: item.modifiedAt,
          path: item.path,
          photoId: item.photoId,
          planId,
          reviewRevision: item.reviewRevision,
        }))
      )
      .run();
    tx.insert(duplicateCleanupEvents)
      .values({
        detailsJson: JSON.stringify({
          deleteCount: itemSnapshots.filter(
            (item) => item.decision === "DELETE"
          ).length,
          keepCount: itemSnapshots.filter((item) => item.decision === "KEEP")
            .length,
        }),
        eventType: "PLAN_CREATED",
        planId,
      })
      .run();
    return tx
      .select()
      .from(duplicateCleanupPlans)
      .where(eq(duplicateCleanupPlans.id, planId))
      .get() as typeof duplicateCleanupPlans.$inferSelect;
  });
  lap("publish", { groups: input.groups.length, items: itemSnapshots.length });

  return planResult(plan, itemSnapshots);
}

function assertItemsStillMatch(
  db: ReturnType<typeof getDatabase>,
  items: (typeof duplicateCleanupPlanItems.$inferSelect)[]
): void {
  const photoIds = items.map((item) => item.photoId);
  const rows = getPhotoRows(db, photoIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== photoIds.length) {
    throw new DuplicateCleanupPlanError(
      "SOURCE_MISSING",
      "A photo in the deletion plan no longer exists"
    );
  }
  for (const item of items) {
    const row = byId.get(item.photoId);
    if (
      !row ||
      row.deletedAt !== null ||
      row.path !== item.path ||
      (row.fileSize ?? 0) !== item.fileSize
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Photo ${item.photoId} changed after the deletion plan was created`
      );
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Execution is a single safety gate that must validate every group before the transaction can write any deletion.
export async function executeDuplicateCleanupPlan(
  input: { planId: string },
  db = getDatabase()
) {
  const plan = db
    .select()
    .from(duplicateCleanupPlans)
    .where(eq(duplicateCleanupPlans.id, input.planId))
    .get();
  if (!plan) {
    throw new DuplicateCleanupPlanError(
      "PLAN_NOT_FOUND",
      "Deletion plan not found"
    );
  }
  if (plan.status === "EXECUTED" && plan.batchId) {
    return {
      alreadyExecuted: true,
      batchId: plan.batchId,
      deletedCount: plan.deletedCount,
      planId: plan.id,
      status: plan.status as DuplicateCleanupPlanStatus,
    };
  }
  assertCurrentDetectionFingerprint(plan.configFingerprint, plan.id);
  assertNoDuplicateScanRunning(db);
  if (plan.status !== "READY") {
    throw new DuplicateCleanupPlanError(
      "PLAN_NOT_READY",
      `Deletion plan is ${plan.status.toLowerCase()}`
    );
  }
  if (plan.expiresAt <= Date.now()) {
    db.update(duplicateCleanupPlans)
      .set({ status: "EXPIRED", updatedAt: Date.now() })
      .where(
        and(
          eq(duplicateCleanupPlans.id, plan.id),
          eq(duplicateCleanupPlans.status, "READY")
        )
      )
      .run();
    throw new DuplicateCleanupPlanError(
      "PLAN_EXPIRED",
      "Deletion plan has expired"
    );
  }

  const items = db
    .select()
    .from(duplicateCleanupPlanItems)
    .where(eq(duplicateCleanupPlanItems.planId, plan.id))
    .all();
  if (items.length === 0) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "Deletion plan is empty"
    );
  }
  const deleteItems = items.filter((item) => item.decision === "DELETE");
  const keepItems = items.filter((item) => item.decision === "KEEP");
  const groups = new Set(items.map((item) => item.groupKey));
  const matchTypeByGroup = new Map<string, "exact" | "similar">();
  for (const groupKey of groups) {
    const groupItems = items.filter((item) => item.groupKey === groupKey);
    if (
      !(
        groupItems.some((item) => item.decision === "KEEP") &&
        groupItems.some((item) => item.decision === "DELETE")
      )
    ) {
      throw new DuplicateCleanupPlanError(
        "NO_KEEPER",
        `Deletion plan group has an invalid keep/delete split: ${groupKey}`
      );
    }
    const review = getReviewRows(db, groupKey);
    const matchType = assertCurrentDuplicateGroup(
      db,
      groupKey,
      review.members.map((member) => member.photoId)
    );
    matchTypeByGroup.set(groupKey, matchType);
    validateSelection(
      {
        deletePhotoIds: groupItems
          .filter((item) => item.decision === "DELETE")
          .map((item) => item.photoId),
        groupKey,
        groupVersion: groupItems[0]?.groupVersion ?? "",
        keepPhotoIds: groupItems
          .filter((item) => item.decision === "KEEP")
          .map((item) => item.photoId),
        matchType: matchTypeByGroup.get(groupKey) ?? "similar",
        reviewRevision: groupItems[0]?.reviewRevision ?? -1,
      },
      review.members,
      review.group
    );
  }
  assertItemsStillMatch(db, items);
  const fingerprints = db
    .select()
    .from(duplicatePhotoFingerprints)
    .where(
      inArray(
        duplicatePhotoFingerprints.photoId,
        items.map((item) => item.photoId)
      )
    )
    .all();
  const fingerprintById = new Map(
    fingerprints.map((fingerprint) => [fingerprint.photoId, fingerprint])
  );
  for (const item of items) {
    /*
     * 自用（2026-11-09 · 会话#11）：执行阶段**只比对元数据，不整份读文件** ✗→✓
     * 原来这里对每张待删图再算一次整文件 SHA-256（实测每张 1~2.5 秒）→ "确定之后还要等" ✗
     * 现在：stat 一次拿大小/修改时间/inode，加上指纹的 contentRevision 就能判断"文件有没有被换过" ✓
     */
    const stat = await fs.promises.stat(item.path).catch(() => null);
    const fingerprint = fingerprintById.get(item.photoId);
    if (
      !stat ||
      !stat.isFile() ||
      item.fileIdentity === null ||
      !sameFileSnapshot(
        {
          fileIdentity: item.fileIdentity,
          fileSize: item.fileSize,
          modifiedAt: item.modifiedAt,
          path: item.path,
        },
        {
          fileIdentity: fileIdentity(stat),
          fileSize: stat.size,
          modifiedAt: stat.mtimeMs,
          path: item.path,
        }
      ) ||
      !fingerprint ||
      fingerprint.contentRevision !== item.contentRevision ||
      fingerprint.path !== item.path ||
      fingerprint.fileSize !== item.fileSize ||
      !sameModifiedAt(fingerprint.modifiedAt, item.modifiedAt) ||
      (fingerprint.fullSha256 !== null &&
        fingerprint.fullSha256 !== item.fullSha256)
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Photo ${item.photoId} changed after the deletion plan was created`
      );
    }
  }
  for (const groupKey of groups) {
    if (matchTypeByGroup.get(groupKey) !== "exact") {
      continue;
    }
    const groupItems = items.filter((item) => item.groupKey === groupKey);
    const representative = groupItems[0];
    if (
      !representative ||
      groupItems.some((item) => item.fullSha256 !== representative.fullSha256)
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Exact duplicate group contains different file bytes: ${groupKey}`
      );
    }
    for (const item of groupItems.slice(1)) {
      if (!(await filesHaveSameBytes(representative.path, item.path))) {
        throw new DuplicateCleanupPlanError(
          "FILE_CHANGED",
          `Exact duplicate group failed byte verification: ${groupKey}`
        );
      }
    }
  }

  const now = Date.now();
  const batchId = randomUUID();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The transaction repeats every safety check before applying the all-or-nothing soft delete.
  const execution = db.transaction((tx) => {
    const currentPlan = tx
      .select()
      .from(duplicateCleanupPlans)
      .where(eq(duplicateCleanupPlans.id, plan.id))
      .get();
    if (!currentPlan) {
      throw new DuplicateCleanupPlanError(
        "PLAN_NOT_FOUND",
        "Deletion plan not found"
      );
    }
    if (currentPlan.status === "EXECUTED" && currentPlan.batchId) {
      return {
        alreadyExecuted: true,
        batchId: currentPlan.batchId,
        deletedCount: currentPlan.deletedCount,
      };
    }
    assertCurrentDetectionFingerprint(
      currentPlan.configFingerprint,
      currentPlan.id
    );
    if (currentPlan.status !== "READY") {
      throw new DuplicateCleanupPlanError(
        "PLAN_NOT_READY",
        "Deletion plan is no longer ready"
      );
    }
    if (currentPlan.expiresAt <= now) {
      tx.update(duplicateCleanupPlans)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(eq(duplicateCleanupPlans.id, currentPlan.id))
        .run();
      throw new DuplicateCleanupPlanError(
        "PLAN_EXPIRED",
        "Deletion plan has expired"
      );
    }
    const activeScan = tx
      .select({ id: duplicateDetectionRuns.id })
      .from(duplicateDetectionRuns)
      .where(
        and(
          eq(duplicateDetectionRuns.status, "running"),
          gt(
            duplicateDetectionRuns.startedAt,
            Date.now() - DUPLICATE_SCAN_LEASE_MS
          )
        )
      )
      .get();
    if (activeScan || hasActiveDuplicateScan()) {
      throw new DuplicateCleanupPlanError(
        "STALE_GROUP",
        "Duplicate detection is still running; execute the plan after it completes"
      );
    }
    const livePairs = tx
      .select({
        photoAId: duplicatePairs.photoAId,
        photoBId: duplicatePairs.photoBId,
      })
      .from(duplicatePairs)
      .all();
    for (const groupKey of groups) {
      const groupItems = items.filter((item) => item.groupKey === groupKey);
      const review = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, groupKey))
        .get();
      const members = tx
        .select({
          contentRevision: duplicateReviewMembers.contentRevision,
          decision: duplicateReviewMembers.decision,
          needsReview: duplicateReviewMembers.needsReview,
          photoId: duplicateReviewMembers.photoId,
        })
        .from(duplicateReviewMembers)
        .where(eq(duplicateReviewMembers.groupKey, groupKey))
        .all();
      if (!review) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate review is missing: ${groupKey}`
        );
      }
      const groupVersion = groupItems[0]?.groupVersion ?? "";
      const reviewRevision = groupItems[0]?.reviewRevision ?? -1;
      validateSelection(
        {
          deletePhotoIds: groupItems
            .filter((item) => item.decision === "DELETE")
            .map((item) => item.photoId),
          groupKey,
          groupVersion,
          keepPhotoIds: groupItems
            .filter((item) => item.decision === "KEEP")
            .map((item) => item.photoId),
          matchType: groupItems[0]?.matchType === "exact" ? "exact" : "similar",
          reviewRevision,
        },
        members,
        review
      );
      const memberIds = members.map((member) => member.photoId);
      const adjacency = new Map<number, number[]>();
      for (const pair of livePairs) {
        adjacency.set(pair.photoAId, [
          ...(adjacency.get(pair.photoAId) ?? []),
          pair.photoBId,
        ]);
        adjacency.set(pair.photoBId, [
          ...(adjacency.get(pair.photoBId) ?? []),
          pair.photoAId,
        ]);
      }
      const expectedMemberIds = new Set(memberIds);
      const seed = memberIds[0];
      const component = new Set<number>();
      if (seed !== undefined) {
        const queue = [seed];
        while (queue.length > 0) {
          const current = queue.pop();
          if (current === undefined || component.has(current)) {
            continue;
          }
          component.add(current);
          queue.push(...(adjacency.get(current) ?? []));
        }
      }
      if (
        component.size !== expectedMemberIds.size ||
        [...component].some((photoId) => !expectedMemberIds.has(photoId))
      ) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate group changed while executing the deletion plan: ${groupKey}`
        );
      }
      const sequenceMember = tx
        .select({ photoId: photoSequenceMembers.photoId })
        .from(photoSequenceMembers)
        .where(inArray(photoSequenceMembers.photoId, memberIds))
        .get();
      if (sequenceMember) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Photo ${sequenceMember.photoId} is managed by a photo sequence`
        );
      }
    }
    const currentPhotos = tx
      .select({
        deletedAt: photos.deletedAt,
        fileSize: photos.fileSize,
        folderId: photos.folderId,
        id: photos.id,
        path: photos.path,
      })
      .from(photos)
      .where(
        inArray(
          photos.id,
          items.map((item) => item.photoId)
        )
      )
      .all();
    const currentPhotoById = new Map(
      currentPhotos.map((photo) => [photo.id, photo])
    );
    const currentFingerprints = tx
      .select()
      .from(duplicatePhotoFingerprints)
      .where(
        inArray(
          duplicatePhotoFingerprints.photoId,
          items.map((item) => item.photoId)
        )
      )
      .all();
    const currentFingerprintById = new Map(
      currentFingerprints.map((fingerprint) => [
        fingerprint.photoId,
        fingerprint,
      ])
    );
    for (const item of items) {
      const photo = currentPhotoById.get(item.photoId);
      const fingerprint = currentFingerprintById.get(item.photoId);
      if (
        !photo ||
        photo.deletedAt !== null ||
        photo.path !== item.path ||
        (photo.fileSize ?? 0) !== item.fileSize ||
        !fingerprint ||
        fingerprint.contentRevision !== item.contentRevision ||
        fingerprint.path !== item.path ||
        fingerprint.fileSize !== item.fileSize ||
        !sameModifiedAt(fingerprint.modifiedAt, item.modifiedAt) ||
        // 指纹里没存哈希（null）时跳过内容哈希比对，其余元数据仍需一致
        (fingerprint.fullSha256 !== null &&
          fingerprint.fullSha256 !== item.fullSha256)
      ) {
        throw new DuplicateCleanupPlanError(
          "FILE_CHANGED",
          `Photo ${item.photoId} changed while executing the deletion plan`
        );
      }
    }
    const activeDeleteIds: number[] = [];
    const folderCounts = new Map<number, number>();
    for (const item of deleteItems) {
      const photo = currentPhotoById.get(item.photoId);
      if (!photo || photo.deletedAt !== null) {
        throw new DuplicateCleanupPlanError(
          "SOURCE_MISSING",
          `Photo ${item.photoId} is no longer active`
        );
      }
      activeDeleteIds.push(photo.id);
      if (photo.folderId !== null) {
        folderCounts.set(
          photo.folderId,
          (folderCounts.get(photo.folderId) ?? 0) + 1
        );
      }
    }
    tx.update(photos)
      .set({ deletionBatchId: batchId, deletedAt: now })
      .where(inArray(photos.id, activeDeleteIds))
      .run();
    for (const [folderId, count] of folderCounts) {
      tx.update(folders)
        .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
        .where(eq(folders.id, folderId))
        .run();
    }
    tx.update(duplicateCleanupPlans)
      .set({
        batchId,
        deletedCount: activeDeleteIds.length,
        executedAt: now,
        status: "EXECUTED",
        updatedAt: now,
      })
      .where(
        and(
          eq(duplicateCleanupPlans.id, currentPlan.id),
          eq(duplicateCleanupPlans.status, "READY")
        )
      )
      .run();
    tx.insert(duplicateCleanupEvents)
      .values({
        batchId,
        detailsJson: JSON.stringify({
          deletedPhotoIds: activeDeleteIds,
          keepPhotoIds: keepItems.map((item) => item.photoId),
        }),
        eventType: "EXECUTED",
        planId: currentPlan.id,
      })
      .run();
    return {
      alreadyExecuted: false,
      batchId,
      deletedCount: activeDeleteIds.length,
    };
  });

  if (!execution.alreadyExecuted) {
    cleanupDeletedPhotoSequenceMembers(db);
    notifySequencesChanged(undefined, "manual");
    invalidateCountCache();
    invalidateStatsCache();
    invalidateSmartAlbumCache();
  }
  return {
    alreadyExecuted: execution.alreadyExecuted,
    batchId: execution.batchId,
    deletedCount: execution.deletedCount,
    planId: plan.id,
    status: "EXECUTED" as const,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch restoration validates every item and records partial outcomes atomically.
export function restoreDuplicateCleanupBatch(
  input: { batchId: string },
  db = getDatabase()
) {
  const plan = db
    .select()
    .from(duplicateCleanupPlans)
    .where(eq(duplicateCleanupPlans.batchId, input.batchId))
    .get();
  if (!plan) {
    throw new DuplicateCleanupPlanError(
      "PLAN_NOT_FOUND",
      "Cleanup batch not found"
    );
  }
  if (plan.status === "RESTORED") {
    return {
      batchId: input.batchId,
      failed: [],
      restoredIds: [],
      status: plan.status,
    };
  }
  if (plan.status !== "EXECUTED" && plan.status !== "RESTORE_PARTIAL") {
    throw new DuplicateCleanupPlanError(
      "RESTORE_FAILED",
      `Cleanup batch cannot be restored from ${plan.status}`
    );
  }
  const items = db
    .select()
    .from(duplicateCleanupPlanItems)
    .where(
      and(
        eq(duplicateCleanupPlanItems.planId, plan.id),
        eq(duplicateCleanupPlanItems.decision, "DELETE")
      )
    )
    .all();
  const rows = getPhotoRows(
    db,
    items.map((item) => item.photoId)
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const failed: Array<{ id: number; filename: string; message: string }> = [];
  const restorable: Array<{ folderId: number | null; id: number }> = [];
  const alreadyRestoredIds: number[] = [];
  const validFolderIds = new Set(
    db
      .select({ id: folders.id })
      .from(folders)
      .all()
      .map((folder) => folder.id)
  );
  for (const item of items) {
    const row = rowById.get(item.photoId);
    if (!row) {
      failed.push({
        id: item.photoId,
        filename: path.basename(item.path),
        message: "Photo record no longer exists",
      });
      continue;
    }
    if (!fs.existsSync(row.path)) {
      failed.push({
        id: item.photoId,
        filename: path.basename(item.path),
        message: "Original file no longer exists",
      });
      continue;
    }
    if (row.deletedAt === null) {
      alreadyRestoredIds.push(row.id);
      continue;
    }
    if (row.deletionBatchId !== input.batchId) {
      failed.push({
        id: item.photoId,
        filename: path.basename(item.path),
        message: "Photo was deleted by a different batch",
      });
      continue;
    }
    restorable.push({ folderId: row.folderId, id: row.id });
  }
  const restoreIds = restorable.map((photo) => photo.id);
  const folderCounts = new Map<number, number>();
  const idsWithFolders: number[] = [];
  const idsWithoutFolders: number[] = [];
  for (const photo of restorable) {
    if (photo.folderId !== null && validFolderIds.has(photo.folderId)) {
      idsWithFolders.push(photo.id);
      folderCounts.set(
        photo.folderId,
        (folderCounts.get(photo.folderId) ?? 0) + 1
      );
    } else {
      idsWithoutFolders.push(photo.id);
    }
  }
  db.transaction((tx) => {
    if (idsWithFolders.length > 0) {
      tx.update(photos)
        .set({ deletionBatchId: null, deletedAt: null })
        .where(inArray(photos.id, idsWithFolders))
        .run();
      for (const [folderId, count] of folderCounts) {
        tx.update(folders)
          .set({ photoCount: sql`photo_count + ${count}` })
          .where(eq(folders.id, folderId))
          .run();
      }
    }
    if (idsWithoutFolders.length > 0) {
      tx.update(photos)
        .set({ deletionBatchId: null, deletedAt: null, folderId: null })
        .where(inArray(photos.id, idsWithoutFolders))
        .run();
    }
    const restoredGroupKeys = new Set(
      items
        .filter((item) => restoreIds.includes(item.photoId))
        .map((item) => item.groupKey)
    );
    for (const groupKey of restoredGroupKeys) {
      const restoredMembers = restoreIds.filter((photoId) =>
        items.some(
          (item) => item.groupKey === groupKey && item.photoId === photoId
        )
      );
      if (restoredMembers.length === 0) {
        continue;
      }
      tx.update(duplicateReviewMembers)
        .set({
          decision: "UNDECIDED",
          needsReview: true,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(duplicateReviewMembers.groupKey, groupKey),
            inArray(duplicateReviewMembers.photoId, restoredMembers)
          )
        )
        .run();
      const reviewGroup = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, groupKey))
        .get();
      if (reviewGroup) {
        const nextRevision = reviewGroup.reviewRevision + 1;
        tx.update(duplicateReviewGroups)
          .set({
            complete: false,
            needsReview: true,
            reviewRevision: nextRevision,
            updatedAt: Date.now(),
          })
          .where(eq(duplicateReviewGroups.groupKey, groupKey))
          .run();
        tx.insert(duplicateReviewEvents)
          .values(
            restoredMembers.map((photoId) => ({
              contentRevision: items.find((item) => item.photoId === photoId)
                ?.contentRevision,
              decision: "UNDECIDED",
              eventType: "RESTORED_REQUIRES_REVIEW",
              groupKey,
              groupVersion: reviewGroup.groupVersion,
              photoId,
              reviewRevision: nextRevision,
            }))
          )
          .run();
      }
    }
    tx.update(duplicateCleanupPlans)
      .set({
        status: failed.length === 0 ? "RESTORED" : "RESTORE_PARTIAL",
        updatedAt: Date.now(),
      })
      .where(eq(duplicateCleanupPlans.id, plan.id))
      .run();
    tx.insert(duplicateCleanupEvents)
      .values({
        batchId: input.batchId,
        detailsJson: JSON.stringify({ failed, restoredIds: restoreIds }),
        eventType: "RESTORED",
        planId: plan.id,
      })
      .run();
  });
  if (restoreIds.length > 0) {
    cleanupDeletedPhotoSequenceMembers(db);
    notifySequencesChanged(undefined, "manual");
    invalidateCountCache();
    invalidateStatsCache();
    invalidateSmartAlbumCache();
  }
  return {
    batchId: input.batchId,
    failed,
    alreadyRestoredIds,
    restoredIds: restoreIds,
    status: (failed.length === 0 ? "RESTORED" : "RESTORE_PARTIAL") as
      | "RESTORED"
      | "RESTORE_PARTIAL",
  };
}