/**
 * 局域网访问（自用新增）—— 配置存储 + 双口令校验。
 *
 * 设计要点（详见工作区根目录的「局域网功能实施计划.md」）：
 *  - 配置全部存 `app_settings` 的通用键值表 → **不需要数据库迁移**
 *  - **两个口令**：一个永久（长期有效）、一个临时（默认 24 小时，可选 1/3/6/12/24）
 *  - **只存 scrypt 哈希 + 随机盐，不存明文**（用户已确认的方案）。
 *    代价是设置页**看不到设过的口令**：
 *      · 永久口令忘了 → 重设一个新的
 *      · 临时口令丢了 → 重新生成（旧口令立即失效）
 *    口令明文只在「生成/设置」的那一刻回传给设置页，用于当场抄给访客。
 *  - 临时口令**只按时长失效**（不做"用 N 次失效"）。
 *  - 默认**关闭**。开启后同一网段的设备都能访问图库，设置页必须给出警告。
 *
 * ⚠️ 口令明文**任何日志都不许打印**。
 */
import crypto from "node:crypto";
import {
  deleteSetting,
  getSetting,
  setSetting,
} from "@/services/settings-manager";

/* ── app_settings 键名 ───────────────────────────────────── */

export const LAN_ENABLED_KEY = "lan.enabled";
export const LAN_PORT_KEY = "lan.port";
export const LAN_PERMANENT_HASH_KEY = "lan.permanentPasswordHash";
export const LAN_PERMANENT_SALT_KEY = "lan.permanentPasswordSalt";
export const LAN_TEMP_HASH_KEY = "lan.tempPasswordHash";
export const LAN_TEMP_SALT_KEY = "lan.tempPasswordSalt";
export const LAN_TEMP_EXPIRES_AT_KEY = "lan.tempPasswordExpiresAt";
export const LAN_TEMP_HOURS_KEY = "lan.tempPasswordHours";

/** 端口合法范围（1024 以下需要管理员权限，不允许）。*/
export const MIN_LAN_PORT = 1024;
export const MAX_LAN_PORT = 65535;
/**
 * 随机端口的取值范围（IANA 动态 / 私有端口段）。
 *
 * 为什么随机而不是写死一个"冷门端口"（比如 47820）：
 * 写死的数字迟早会和别人电脑上的某个软件撞上，而撞了之后用户只会看到
 * "启动失败"却不知道原因。首次启用时随机挑一个并落库，就能把撞端口概率降到很低；
 * 用户也可以在设置页手动改，或者点"换一个随机端口"。
 */
export const LAN_RANDOM_PORT_MIN = 49_152;
export const LAN_RANDOM_PORT_MAX = 65_535;
/** 临时口令可选的有效时长（小时）。默认 24。*/
export const TEMP_PASSWORD_HOUR_OPTIONS = [1, 3, 6, 12, 24] as const;
export const DEFAULT_TEMP_HOURS = 24;
/** 口令最短长度。*/
export const MIN_PASSWORD_LENGTH = 6;
/** 随机口令长度（临时口令要手输到手机上，所以短一点）。*/
export const RANDOM_PERMANENT_LENGTH = 12;
export const RANDOM_TEMP_LENGTH = 10;
/** 随机口令字符集：去掉 0/O、1/l/I 等易混字符，方便口头/手抄转达。*/
const RANDOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** scrypt 派生长度（字节）。*/
const SCRYPT_KEY_LENGTH = 64;
/** 盐长度（字节）。*/
const SALT_BYTES = 16;

const HOUR_MS = 60 * 60 * 1000;

/**
 * 设置页要看的配置视图。
 *
 * ⚠️ **故意不包含任何口令字段** —— 口令只存哈希，本来就取不回来；
 * 这样也能保证"读配置"这条路径永远不会把口令带进日志或界面。
 */
export interface LanConfigView {
  /** 是否允许局域网访问（false 时只监听 127.0.0.1）。*/
  enabled: boolean;
  /** 监听端口。*/
  port: number;
  /** 是否已设置永久口令（局域网模式的前置条件）。*/
  hasPermanentPassword: boolean;
  /** 临时口令是否已设置（可能已过期）。*/
  tempPasswordSet: boolean;
  /** 临时口令当前是否有效（已设置且未过期）。*/
  tempPasswordActive: boolean;
  /** 临时口令过期时间戳（毫秒）；null 表示没设过。*/
  tempPasswordExpiresAt: number | null;
  /** 生成临时口令时选的有效时长（小时）。*/
  tempPasswordHours: number;
  /** 是否真的会监听局域网（开关 + 口令 + 端口三者都满足）。*/
  listeningOnLan: boolean;
}

/* ── 基础读写 ─────────────────────────────────────────────── */

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw === null) {
    return fallback;
  }
  return raw === "1" || raw === "true";
}

function readInt(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === null) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readTempExpiresAt(): number | null {
  const raw = getSetting(LAN_TEMP_EXPIRES_AT_KEY);
  if (!raw) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

export function isValidLanPort(port: number): boolean {
  return (
    Number.isInteger(port) && port >= MIN_LAN_PORT && port <= MAX_LAN_PORT
  );
}

/** 在动态端口段里随机挑一个端口号（**不检查是否被占用**，占用由监听失败兜底）。*/
export function randomLanPort(): number {
  return crypto.randomInt(LAN_RANDOM_PORT_MIN, LAN_RANDOM_PORT_MAX + 1);
}

/**
 * 读取监听端口；**没有设置过或存的值不合法时，随机挑一个并落库**（自愈）。
 *
 * 这样"默认端口"就是一个随机值，而不是一个可能和别人撞车的固定数字。
 * 用户随时可以在设置页改它，或者调 {@link setRandomLanPort} 再随机一个。
 */
export function ensureLanPort(): number {
  const stored = Number.parseInt(getSetting(LAN_PORT_KEY) ?? "", 10);
  if (isValidLanPort(stored)) {
    return stored;
  }
  const port = randomLanPort();
  setSetting(LAN_PORT_KEY, String(port));
  return port;
}

export function setLanPort(port: number): void {
  if (!isValidLanPort(port)) {
    throw new Error(`端口需要在 ${MIN_LAN_PORT}–${MAX_LAN_PORT} 之间`);
  }
  setSetting(LAN_PORT_KEY, String(port));
}

/** 换一个随机端口并落库，返回新端口。*/
export function setRandomLanPort(): number {
  const port = randomLanPort();
  setSetting(LAN_PORT_KEY, String(port));
  return port;
}

function normalizeTempHours(hours: number): number {
  return (TEMP_PASSWORD_HOUR_OPTIONS as readonly number[]).includes(hours)
    ? hours
    : DEFAULT_TEMP_HOURS;
}

/** 读取完整配置视图（**不含**任何口令或哈希）。*/
export function getLanConfig(): LanConfigView {
  const hasPermanentPassword = getSetting(LAN_PERMANENT_HASH_KEY) !== null;
  const tempHash = getSetting(LAN_TEMP_HASH_KEY);
  const tempPasswordExpiresAt = readTempExpiresAt();
  const tempPasswordSet = tempHash !== null && tempHash.length > 0;
  const tempPasswordActive =
    tempPasswordSet &&
    tempPasswordExpiresAt !== null &&
    tempPasswordExpiresAt > Date.now();
  const port = ensureLanPort();
  const enabled = readBoolean(LAN_ENABLED_KEY, false);
  return {
    enabled,
    port,
    hasPermanentPassword,
    tempPasswordSet,
    tempPasswordActive,
    tempPasswordExpiresAt,
    tempPasswordHours: normalizeTempHours(
      readInt(LAN_TEMP_HOURS_KEY, DEFAULT_TEMP_HOURS)
    ),
    // 三个条件缺一不可：即使用户误开开关，也不会出现"能访问但没口令"的开放状态。
    listeningOnLan:
      enabled &&
      hasPermanentPassword &&
      port >= MIN_LAN_PORT &&
      port <= MAX_LAN_PORT,
  };
}

export function setLanEnabled(enabled: boolean): void {
  setSetting(LAN_ENABLED_KEY, enabled ? "1" : "0");
}

/* ── 口令哈希 ─────────────────────────────────────────────── */

function derive(password: string, saltHex: string): Buffer {
  return crypto.scryptSync(password, saltHex, SCRYPT_KEY_LENGTH);
}

/** 生成「哈希 + 盐」，两者都是十六进制字符串。*/
function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  return { hash: derive(password, salt).toString("hex"), salt };
}

/** 定长比较，避免通过响应时间猜口令。*/
function matchesHash(
  candidate: string,
  salt: string | null,
  expectedHash: string | null
): boolean {
  if (!(salt && expectedHash)) {
    return false;
  }
  const actual = derive(candidate, salt);
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * 生成一个随机口令。
 *
 * 用 `crypto.randomBytes` + 取模会有极轻微的分布偏差，但字符集 31 与 256 的
 * 偏差对本场景（局域网自用口令）完全没有实际影响；这里刻意保持实现简单。
 */
export function generateRandomPassword(length: number): string {
  const bytes = crypto.randomBytes(length);
  let password = "";
  for (const byte of bytes) {
    password += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
  }
  return password;
}

/* ── 永久口令 ─────────────────────────────────────────────── */

/**
 * 设置永久口令。
 *
 * @throws 口令短于 {@link MIN_PASSWORD_LENGTH} 时抛错（空串请用
 *         {@link clearPermanentPassword}）。
 */
export function setPermanentPassword(password: string): void {
  const trimmed = password.trim();
  if (trimmed.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`口令至少需要 ${MIN_PASSWORD_LENGTH} 位`);
  }
  const { hash, salt } = hashPassword(trimmed);
  setSetting(LAN_PERMANENT_HASH_KEY, hash);
  setSetting(LAN_PERMANENT_SALT_KEY, salt);
  // 换口令即作废所有已发放的会话（阶段 2 的会话表按口令版本号校验）。
  bumpCredentialRevision();
}

/** 生成一个随机永久口令，返回明文供设置页**当场显示一次**。*/
export function generatePermanentPassword(): string {
  const password = generateRandomPassword(RANDOM_PERMANENT_LENGTH);
  setPermanentPassword(password);
  return password;
}

export function clearPermanentPassword(): void {
  deleteSetting(LAN_PERMANENT_HASH_KEY);
  deleteSetting(LAN_PERMANENT_SALT_KEY);
  bumpCredentialRevision();
}

/* ── 临时口令 ─────────────────────────────────────────────── */

/**
 * 设置临时口令（自定义）。
 *
 * @returns 过期时间戳（毫秒）。
 * @throws 口令短于 {@link MIN_PASSWORD_LENGTH} 时抛错。
 */
export function setTempPassword(password: string, hours: number): number {
  const trimmed = password.trim();
  if (trimmed.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`口令至少需要 ${MIN_PASSWORD_LENGTH} 位`);
  }
  const validHours = normalizeTempHours(hours);
  const { hash, salt } = hashPassword(trimmed);
  const expiresAt = Date.now() + validHours * HOUR_MS;
  setSetting(LAN_TEMP_HASH_KEY, hash);
  setSetting(LAN_TEMP_SALT_KEY, salt);
  setSetting(LAN_TEMP_EXPIRES_AT_KEY, String(expiresAt));
  setSetting(LAN_TEMP_HOURS_KEY, String(validHours));
  bumpCredentialRevision();
  return expiresAt;
}

/**
 * 生成随机临时口令。
 *
 * @returns 口令明文（设置页要**当场显示一次**给访客）与过期时间戳。
 */
export function generateTempPassword(hours: number): {
  password: string;
  expiresAt: number;
} {
  const password = generateRandomPassword(RANDOM_TEMP_LENGTH);
  const expiresAt = setTempPassword(password, hours);
  return { password, expiresAt };
}

/** 清除临时口令（旧的临时口令立即失效）。*/
export function clearTempPassword(): void {
  deleteSetting(LAN_TEMP_HASH_KEY);
  deleteSetting(LAN_TEMP_SALT_KEY);
  deleteSetting(LAN_TEMP_EXPIRES_AT_KEY);
  bumpCredentialRevision();
}

/**
 * 修改临时口令的有效时长。
 *
 * 已设置临时口令时，过期时间从**现在**重新起算（顺延/缩短）；
 * 没有临时口令时只记住这个偏好，等下次生成时使用。
 */
export function setTempPasswordHours(hours: number): void {
  const validHours = normalizeTempHours(hours);
  setSetting(LAN_TEMP_HOURS_KEY, String(validHours));
  const hasTempPassword = (getSetting(LAN_TEMP_HASH_KEY) ?? "").length > 0;
  if (hasTempPassword) {
    setSetting(
      LAN_TEMP_EXPIRES_AT_KEY,
      String(Date.now() + validHours * HOUR_MS)
    );
  }
}

/** 临时口令剩余毫秒数（没有临时口令或已过期返回 0）。*/
export function tempPasswordRemainingMs(): number {
  const expiresAt = readTempExpiresAt();
  if (expiresAt === null) {
    return 0;
  }
  const hasTempPassword = (getSetting(LAN_TEMP_HASH_KEY) ?? "").length > 0;
  if (!hasTempPassword) {
    return 0;
  }
  return Math.max(0, expiresAt - Date.now());
}

/* ── 口令版本号（供阶段 2 的会话失效使用）─────────────────── */

export const LAN_CREDENTIAL_REVISION_KEY = "lan.credentialRevision";

/**
 * 口令变更计数。
 *
 * 阶段 2 会给登录成功的设备发一个会话 Cookie；会话里带上当时的版本号，
 * 于是**改口令 = 所有旧会话立即失效**，不需要另外维护会话表。
 */
export function getCredentialRevision(): string {
  return getSetting(LAN_CREDENTIAL_REVISION_KEY) ?? "0";
}

function bumpCredentialRevision(): void {
  const current = Number.parseInt(getCredentialRevision(), 10);
  const next = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
  setSetting(LAN_CREDENTIAL_REVISION_KEY, String(next));
}

/* ── 校验 ─────────────────────────────────────────────────── */

export interface LanAuthResult {
  ok: boolean;
  /** 通过的是哪种口令（用于日志/调试，**不要记录口令本身**）。*/
  kind: "permanent" | "temp" | null;
}

/**
 * 校验 HTTP 请求带的口令。
 *
 * ⚠️ 返回值刻意不区分"口令错误"和"临时口令已过期" —— 对外一律 401，
 * 避免给爆破者额外的信息。
 *
 * ⚠️ scrypt 是**故意慢**的（每次约几十毫秒）。这个函数只应该在**登录**时调用；
 * 阶段 2 的其余请求走会话 Cookie（见 {@link getCredentialRevision}），
 * 不要在每个缩略图请求上跑它。
 */
export function verifyLanPassword(candidate: string | null): LanAuthResult {
  if (!candidate) {
    return { ok: false, kind: null };
  }
  const permanentHash = getSetting(LAN_PERMANENT_HASH_KEY);
  const permanentSalt = getSetting(LAN_PERMANENT_SALT_KEY);
  if (matchesHash(candidate, permanentSalt, permanentHash)) {
    return { ok: true, kind: "permanent" };
  }
  // 过期的临时口令不参与校验。
  if (tempPasswordRemainingMs() > 0) {
    const tempHash = getSetting(LAN_TEMP_HASH_KEY);
    const tempSalt = getSetting(LAN_TEMP_SALT_KEY);
    if (matchesHash(candidate, tempSalt, tempHash)) {
      return { ok: true, kind: "temp" };
    }
  }
  return { ok: false, kind: null };
}

/** 是否已经设置了永久口令（局域网模式的前置条件）。*/
export function hasPermanentPassword(): boolean {
  return (getSetting(LAN_PERMANENT_HASH_KEY) ?? "").length > 0;
}

/**
 * 是否应该开启局域网监听。
 *
 * 与 {@link getLanConfig} 的 `listeningOnLan` 同义，保留成函数是为了
 * 让调用方（HTTP 服务器）读起来更直白。
 */
export function shouldListenOnLan(): boolean {
  return getLanConfig().listeningOnLan;
}
