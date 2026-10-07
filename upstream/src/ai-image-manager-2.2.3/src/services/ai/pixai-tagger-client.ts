/**
 * PixAI Tagger v1.0 worker 客户端（自用新增，NEXT 版）。
 *
 * 与 `wd14-tagger-client.ts` 是**孪生实现**：worker 的消息协议**完全同构**
 * （见 `scripts/pixai-tagger-worker.mjs` 头部注释），所以这里只列出
 * **不能照抄**的地方：
 *
 *  | 项 | WD14 | PixAI |
 *  |---|---|---|
 *  | 模型体积 | 361 MB | **1.86 GB**（每进程都全量加载）|
 *  | 词表 | 10,861 | **30,877** |
 *  | embedding | 768 维 | **1024 维**（`PIXAI_EMBEDDING_DIM`）|
 *  | `tags[].category` | **数字**（0/4/9）| **字符串**（`"general"`…`"rating"`）|
 *  | 阈值来源 | general/character 两个开关 | **六分类各一个**（`pixai-tag-categories`）|
 *  | 输入尺寸 | 448（缩略图 512 够用）| **1008**（512 缩略图要放大，见下）|
 *
 * ### 为什么还是**单个常驻 worker**
 * 照 WD14 的取舍（`wd14-tagger-client.ts` 头部注释），且这里更极端：
 * PixAI 的 ONNX 是 1.86 GB，`fork()` 出来的子进程各自 `require` 一份
 * onnxruntime session（换模型要重读 1.86 GB），再加上 1008×1008 NCHW 的
 * 中间张量与 30,877 维 logits 缓冲。多开 worker 的内存是**线性增长**，
 * 在 8–16 GB 的机器上很容易把整机拖进换页。所以 `WORKER_COUNT = 1` 是默认，
 * 要提速就改这一个常量（请求会按空闲槽位分发）。
 *
 * ### ⚠️ DirectML 会**整进程**原生崩溃（本章是这个文件存在的主要理由）
 * `graphOptimizationLevel` 必须 `"disabled"`（模型 9,217 个节点，ORT 1.26 的图
 * 优化器栈溢出 → 0xC0000005），**但即使配对了，DML 仍可能在推理中途崩掉整个
 * worker 进程** —— 这是原生层段错误，`try/catch` 抓不到，只能靠 `exit` 事件发现。
 * 交接文档也记了这个坑：测速脚本 `bench_one.cjs` 是"**单配置一个进程**，防崩溃带走结果"。
 *
 * 所以这里必须做到"崩了还能自己爬起来"，具体三件事：
 *  1. **`exit` 事件里把 `initPromise` 置回 `null`**（见 `handleWorkerExit()`）。
 *     ⚠️ 这正是 WD14 客户端那个已知缺陷：它只在 `initWd14Tagger` 的 `catch`
 *     里重置 `initPromise`，而"worker 运行中崩溃"走的是 `exit` 事件、
 *     **不经过那个 catch** → `initPromise` 永远是非空 Promise →
 *     再调 `initWd14Tagger` 被 `if (initPromise) return initPromise` 直接短路 →
 *     `isWd14TaggerReady()` 恒为 false，**只能重启应用**。
 *  2. **下一批打标会自动重新拉起**（`tagPhotoBatchPixai` 里 `isPixaiTaggerReady()`
 *     为假且有缓存 `modelsDir` 时先 `initPixaiTagger()`），不需要上层手动重试。
 *  3. **错误一律报出来**，绝不静默：进程退出 → reject 当前批次并 `log.error`；
 *     worker 报 `provider-error`（DML 崩）→ 连 provider 名一起 reject + `log.error`。
 *
 * ### ⚠️ DML 连续崩溃后**自动降级 CPU**
 * 只在 `provider-error` 之后才降级，且**只降一次**：第一次 DML 初始化失败
 * （worker 内部会自己退回 CPU）不算；若新拉起的 worker 又是 DML 并在推理中崩，
 * `lastInitWasProviderError` 为真 → 下一次 init 直接 `useGPU = false`。
 * 否则会陷入"拉起 → 崩溃 → 拉起"的死循环，每个循环还要重读 1.86 GB 模型。
 * 调用方若想重新试 GPU，用**不同的参数**调一次 `initPixaiTagger(dir, true)` 即可
 * （参数变化会清掉这个降级记忆，见 `initPixaiTagger`）。
 *
 * ### 关于喂进去的图片路径（⚠️ 与 WD14 的结论相反）
 * WD14 鼓励传 512px 缩略图（要 448，够用且省 IO）。PixAI 要 **1008px**，
 * 传 512 缩略图会被**放大** 2 倍 → 细节已经丢掉了，`grey_hair` 这类细粒度标签
 * 的准确率会下降（这正是交接文档 §2.3 用"灰发布洛妮娅"做自检判据的原因）。
 * 所以这个文件**不替调用方决定**：路径由调用方给，这里只负责把图片送到 worker。
 */

import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { PRIVATE_BUILD } from "@/config/private-build";
import { createLogger } from "@/utils/logger";
import type { PixaiCategoryName } from "./pixai-tag-categories";

const log = createLogger("pixai-tagger");

/**
 * 同时常驻的 worker 数量。
 *
 * 为什么需要 >1：单个 worker 里「CPU 预处理 → GPU 推理」是**串行**的 —— DirectML
 * 推理时 CPU 在解码/归一化，显卡只能等，所以 1 个 worker 时显卡长期只用到一半。
 * 两个 worker 就能把预处理与推理叠起来（实测 DirectML 单 worker 约占 2.4 GB 显存）。
 *
 * 为什么不写死 2：PixAI 模型 1.86 GB，**CPU 回退**时单个 worker 实测能吃到约 10 GB
 * 内存，小内存机器多开会换页。所以按物理内存自适应：≥24 GB 用 2，否则维持 1。
 * 需要手工指定时设环境变量 `AIM_PIXAI_WORKERS=1..4`。
 */
const WORKER_COUNT = resolveWorkerCount();

function resolveWorkerCount(): number {
  const override = Number.parseInt(process.env.AIM_PIXAI_WORKERS ?? "", 10);
  if (Number.isFinite(override) && override >= 1 && override <= 4) {
    return override;
  }
  return os.totalmem() >= 24 * 1024 ** 3 ? 2 : 1;
}
/**
 * 单批超时（毫秒）。
 * 按 0.59 秒/张（DirectML）给足余量：320 张 ≈ 190 秒，300 秒够一批。
 * 超时不是"放弃"而是"判定这个 worker 已经废了" → 杀掉，下一批重新拉起。
 */
const BATCH_TIMEOUT_MS = 300_000;
/**
 * 等 `ready` 的上限（毫秒）。
 * 1.86 GB 模型冷启动：CPU 实测 3.8 秒就绪（见实施计划 §0），DML 首次要编译
 * 执行计划，慢一个量级。120 秒是"磁盘被别的 IO 抢占"时的兜底，不是正常耗时。
 */
const READY_TIMEOUT_MS = 120_000;

/** 1024 维动漫特征（L2 归一化，保留 5 位小数）。WD14 是 768。 */
export const PIXAI_EMBEDDING_DIM = 1024;

export interface PixaiTag {
  /** 标签名（英文 / 罗马字，与 `config.json` 的 `tags` 一致） */
  name: string;
  /**
   * ⚠️ **字符串**大类名，不是 WD14 那种数字 category。
   * 由 worker 按 `tags_split` 的区间带出，客户端不猜。
   */
  category: PixaiCategoryName;
  /** 0–5，`tags_split` 里的顺序下标（`general`=0 … `rating`=5） */
  categoryIndex: number;
  score: number;
}

export interface PixaiPhotoResult {
  id: number;
  tags?: PixaiTag[];
  /** 1024 维动漫特征，仅当 includeEmbedding 时返回 */
  embedding?: number[];
  error?: string;
}

export interface PixaiTagRequest {
  id: number;
  path: string;
}

export interface PixaiTagOptions {
  /** 逐分类覆盖阈值；**不传就不发这个字段**，让 worker 用它自己的默认值。 */
  thresholds?: Partial<Record<PixaiCategoryName, number>>;
  includeEmbedding?: boolean;
}

export interface PixaiTaggerState {
  enabled: boolean;
  modelsDir: string;
  useGpu: boolean;
  workers: number;
  ready: boolean;
  shuttingDown: boolean;
}

interface WorkerSlot {
  process: ChildProcess;
  index: number;
  ready: boolean;
  dead: boolean;
}

interface PendingBatch {
  resolve: (results: PixaiPhotoResult[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let slots: WorkerSlot[] = [];
let slotPending = new Map<number, PendingBatch>();
/**
 * ⚠️ 这个变量会在 **worker `exit`** 时被重置（WD14 客户端的缺陷就在这里）。
 * 语义：非 null 表示"当前这一代 worker 的初始化过程"。
 */
let initPromise: Promise<void> | null = null;
let resolvedModelsDir = "";
/** 调用方**请求**的 GPU 设定（诊断面板显示这个，而不是实际生效的那个）。 */
let resolvedUseGpu = false;
/** 实际发给 worker 的 GPU 设定：DML 崩过之后这里是 false（自动降级 CPU）。 */
let effectiveUseGpu = false;
/**
 * 上一次 init 是因为 **worker 报 `provider-error`**（DML 原生崩溃）而失败的吗。
 * 只用来决定"下次 init 要不要降级 CPU"，见文件头注释。
 */
let lastInitWasProviderError = false;
let shuttingDown = false;

/**
 * 功能开关。
 *
 * ⚠️ `private-build.ts` 里的 `usePixaiTagger` 由**另一个代理**负责新增（见
 * 「PixAI集成实施计划.md」§2.1），本文件不允许改那个文件，所以这里用
 * **带兜底的运行时读取**，三种情况都不会白屏也不会崩：
 *   - 开关已加且为 `true`  → 用 PixAI
 *   - 开关已加且为 `false` → 回退 WD14（本文件的导出函数全部变成 no-op）
 *   - 开关还不存在（当前状态）→ 退回 `PRIVATE_BUILD.useWd14Tagger`：
 *     那个开关为 true 表示"要用本地打标模型"，此时 PixAI 客户端可用是合理的默认
 *     （真正选哪个模型由上层 `pixai-tagger.ts` / 打标服务决定）。
 *     开关一旦加上，这一行自动改用新开关，**不需要再动本文件**。
 *
 * `enabled` 只做"客户端能不能被拉起"的门禁；具体用哪个模型是上层的事，
 * 所以默认放行比默认拦截安全（默认拦截会表现为"什么都没发生"，最难查）。
 */
function isEnabled(): boolean {
  const flags = PRIVATE_BUILD as unknown as Record<string, unknown>;
  const flag = flags.usePixaiTagger;
  if (typeof flag === "boolean") {
    return flag;
  }
  return PRIVATE_BUILD.useWd14Tagger;
}

function findWorkerScript(): string {
  const fileName = "pixai-tagger-worker.mjs";
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      fileName
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    const bundled = path.join(process.resourcesPath, "scripts", fileName);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", fileName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", fileName);
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error(`${fileName} not found`);
}

/**
 * PixAI 模型是否已就位（缺文件时在这里就给出**带完整路径**的原因，
 * 而不是让 worker 初始化一半再报 `init-error`）。
 *
 * ⚠️ 官方权重是 `model.safetensors` + Python 侧导出脚本；本项目只跑 ONNX，
 * 所以**必须有 `pixai-tagger-v1.0.onnx`**（1.86 GB）**和 `config.json`**（677 KB，
 * 30,877 个标签名 + `tags_split` 区间 + 阈值）。少了 `config.json` 连词表都建不出来。
 */
/**
 * 从**安装包**（`resources/models-release/pixai-tagger-v1.0/`）定向播种 PixAI 模型。
 *
 * 背景：`ensureLocalModel()` 只在图库缺 SigLIP 时才整体复制安装包的 `models-release`，
 * 所以"图库已有 SigLIP、但还没有 PixAI"（老用户升级上来）这条路上，包里带的模型
 * 永远不会到位。这里按需补一次；只在打包版且源存在时动作。
 *
 * ⚠️ 失败**只 warn 不抛**：真正的失败判定交给调用方那条明确的
 *    「PixAI 模型文件缺失：…」错误，不会静默跳过。
 */
function seedPixaiModelFromBundledResources(modelsDir: string): void {
  try {
    if (!app.isPackaged) {
      return;
    }
    const sourceDir = path.join(
      process.resourcesPath,
      "models-release",
      "pixai-tagger-v1.0"
    );
    if (!fs.existsSync(sourceDir)) {
      log.info(
        "PixAI：图库与安装包都没有模型（打包时未包含模型属正常配置），跳过播种"
      );
      return;
    }
    const targetDir = path.join(modelsDir, "pixai-tagger-v1.0");
    fs.mkdirSync(targetDir, { recursive: true });
    let copied = 0;
    for (const fileName of ["pixai-tagger-v1.0.onnx", "config.json"]) {
      const source = path.join(sourceDir, fileName);
      if (!fs.existsSync(source)) {
        continue;
      }
      const target = path.join(targetDir, fileName);
      if (
        fs.existsSync(target) &&
        fs.statSync(target).size === fs.statSync(source).size
      ) {
        continue;
      }
      fs.copyFileSync(source, target);
      copied += 1;
    }
    log.info(
      { copied, targetDir },
      "PixAI：已把安装包里的模型播种到图库（models-release → dataPath/models）"
    );
  } catch (error) {
    log.warn(
      { err: error },
      "PixAI：从安装包播种模型失败（会继续尝试直接加载）"
    );
  }
}

export function isPixaiModelAvailable(modelsDir: string): boolean {
  const dir = path.join(modelsDir, "pixai-tagger-v1.0");
  return (
    fs.existsSync(path.join(dir, "pixai-tagger-v1.0.onnx")) &&
    fs.existsSync(path.join(dir, "config.json"))
  );
}

/** 拒绝该槽位上正在等的批次（没有则什么都不做）。 */
function failSlot(index: number, error: Error): void {
  const pending = slotPending.get(index);
  if (pending) {
    clearTimeout(pending.timer);
    slotPending.delete(index);
    pending.reject(error);
  }
}

/**
 * worker 退出处理：**这里是修掉 WD14 那个缺陷的地方**。
 *
 * 顺序很重要：
 *  1. 标记 `dead`（`isPixaiTaggerReady()` 立刻变 false）；
 *  2. reject 该槽位上挂着的批次 —— 崩溃不能让调用方**永远 await 下去**；
 *  3. **`initPromise = null`**：让"下一次 `initPixaiTagger()`"真的能重新 `fork`
 *     worker，而不是被 `if (initPromise) return initPromise` 短路成一个
 *     已经 resolve 完的旧 Promise（那就会 `ready` 恒为 false，直到重启应用）；
 *  4. 若一个活的槽位都不剩，就把槽位数组清空（留着死槽位会让
 *     `acquireSlot()` 报"未就绪"这种没信息量的错）。
 *
 * `shuttingDown` 时**不重置** `initPromise` —— 那是主动关闭，不是崩溃。
 */
function handleWorkerExit(slot: WorkerSlot, code: number | null): void {
  slot.dead = true;
  slot.ready = false;
  const wasPending = slotPending.has(slot.index);
  failSlot(
    slot.index,
    new Error(
      `PixAI worker ${slot.index} 已退出（code ${code ?? "null"}）${
        wasPending ? "，正在处理的批次已失败" : ""
      }`
    )
  );
  // ⚠️ 关键一行：不重置的话下一次 init 会被永久短路（WD14 的既有缺陷）
  initPromise = null;
  if (!shuttingDown && slots.every((entry) => entry.dead)) {
    slots = [];
  }
  log.warn(
    { index: slot.index, code, wasPending },
    "PixAI worker 退出（已重置 initPromise，下一批会自动重新拉起）"
  );
}

function spawnSlot(index: number): WorkerSlot {
  const script = findWorkerScript();
  const child = fork(script, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const slot: WorkerSlot = {
    process: child,
    index,
    ready: false,
    dead: false,
  };

  // ⚠️ 绝不能吞 stderr：worker 的 `console.error` 里有 DML 退回 CPU 的原因、
  // ORT 的原生警告 —— 排查"为什么慢十倍"全靠它（交接文档 §5.3 的排查表）。
  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      log.warn({ index }, text);
    }
  });

  child.on("message", (raw: unknown) => {
    const message = raw as {
      type?: string;
      error?: string;
      provider?: string;
      results?: PixaiPhotoResult[];
    };
    if (message.type === "ready") {
      slot.ready = true;
      log.info(
        { index, provider: message.provider },
        "PixAI worker 就绪"
      );
      return;
    }
    if (message.type === "result") {
      const pending = slotPending.get(index);
      if (pending) {
        clearTimeout(pending.timer);
        slotPending.delete(index);
        pending.resolve(message.results ?? []);
      }
      return;
    }
    if (message.type === "provider-error") {
      // DML 在推理中崩了：worker 自己选择**不**把整批当结果发回来，而是报错。
      // 这里要做的：标记不可用 + 把错误**报出去**（不静默）。
      slot.ready = false;
      lastInitWasProviderError = true;
      const error = new Error(
        `PixAI worker provider 错误（${message.provider ?? "unknown"}）：${
          message.error ?? "未知原因"
        }`
      );
      log.error(
        { index, provider: message.provider },
        "PixAI 推理失败，下一次 init 将自动降级 CPU"
      );
      failSlot(index, error);
      return;
    }
    if (message.type === "init-error") {
      slot.ready = false;
      lastInitWasProviderError = true;
      const error = new Error(message.error ?? "PixAI worker 初始化失败");
      log.error({ index }, error.message);
      failSlot(index, error);
    }
  });

  child.on("exit", (code) => handleWorkerExit(slot, code));
  child.on("error", (error) => {
    failSlot(index, error instanceof Error ? error : new Error(String(error)));
    handleWorkerExit(slot, null);
  });

  return slot;
}

function waitForReady(slot: WorkerSlot, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (slot.ready) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (slot.dead || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `PixAI worker ${slot.index} 初始化${
              slot.dead ? "时已退出" : "超时"
            }（上限 ${timeoutMs} ms）`
          )
        );
      }
    }, 100);
  });
}

/**
 * 启动 worker 并加载模型。可重复调用（已就绪时直接返回同一个 Promise）。
 *
 * @param modelsDir `<dataPath>/models`（下面必须有 `pixai-tagger-v1.0/`）
 * @param useGpu    true 时 worker 用 `["dml","cpu"]`；DML 初始化失败会由 worker
 *                  内部退回 CPU。若上一次 init 是 DML **推理中崩溃**，
 *                  这里会自动改成 `useGPU: false`（只降一次，见文件头注释）。
 */
export async function initPixaiTagger(
  modelsDir: string,
  useGpu: boolean
): Promise<void> {
  if (!isEnabled()) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }
  // 参数变了 = 调用方想重新试一次，清掉 DML 降级记忆
  if (modelsDir !== resolvedModelsDir || useGpu !== resolvedUseGpu) {
    lastInitWasProviderError = false;
  }
  resolvedModelsDir = modelsDir;
  resolvedUseGpu = useGpu;
  // DML 上次把进程搞崩了 → 这次直接 CPU，别再去送一次死
  effectiveUseGpu = useGpu && !lastInitWasProviderError;
  if (useGpu && !effectiveUseGpu) {
    log.warn("PixAI：上一次 DirectML 推理崩溃，本次 init 自动改用 CPU");
  }
  shuttingDown = false;

  initPromise = (async () => {
    // 图库缺模型时，先尝试从**安装包**里播种（NEXT 新增）。
    //
    // 为什么需要：`ensureLocalModel()` 只在图库缺 SigLIP 时才把安装包的
    // `models-release` 整目录复制过来；**图库已有 SigLIP（老用户升上来）时它不会复制**，
    // 于是安装包里带的 PixAI 模型就永远不会到位。这里做一次定向自愈。
    if (!isPixaiModelAvailable(modelsDir)) {
      seedPixaiModelFromBundledResources(modelsDir);
    }
    if (!isPixaiModelAvailable(modelsDir)) {
      throw new Error(
        `PixAI 模型文件缺失：需要 ${path.join(
          modelsDir,
          "pixai-tagger-v1.0"
        )} 下的 pixai-tagger-v1.0.onnx 与 config.json`
      );
    }
    slots = [];
    slotPending = new Map();
    for (let i = 0; i < WORKER_COUNT; i++) {
      const slot = spawnSlot(i);
      slots.push(slot);
      slot.process.send({
        type: "init",
        modelsDir,
        useGPU: effectiveUseGpu,
      });
    }
    await Promise.all(slots.map((slot) => waitForReady(slot, READY_TIMEOUT_MS)));
    log.info(
      { workers: slots.length, requestedGpu: useGpu, effectiveGpu: effectiveUseGpu },
      "PixAI tagger 就绪"
    );
  })().catch((error) => {
    // 初始化失败：清掉 Promise 并收拾掉半死的 worker，让下一次调用能干净重来
    initPromise = null;
    const text = error instanceof Error ? error.message : String(error);
    log.error({ useGpu: effectiveUseGpu }, `PixAI tagger 初始化失败：${text}`);
    shutdownPixaiTagger();
    throw error instanceof Error ? error : new Error(text);
  });

  return initPromise;
}

export function isPixaiTaggerReady(): boolean {
  return slots.length > 0 && slots.every((slot) => slot.ready && !slot.dead);
}

/** 取一个空闲且存活的槽位；没有则返回 null。 */
function pickIdleSlot(): WorkerSlot | null {
  for (const slot of slots) {
    if (slot.ready && !slot.dead && !slotPending.has(slot.index)) {
      return slot;
    }
  }
  return null;
}

/** 等一个空闲槽位（用于顺序化多批请求）。 */
async function acquireSlot(timeoutMs = 60_000): Promise<WorkerSlot> {
  const started = Date.now();
  for (;;) {
    const slot = pickIdleSlot();
    if (slot) {
      return slot;
    }
    if (!isPixaiTaggerReady()) {
      throw new Error("PixAI tagger 未就绪");
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待 PixAI 空闲 worker 超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 对一批照片打标签。
 *
 * 崩溃自愈：如果 worker 已经在推理中崩掉了（`isPixaiTaggerReady()` 为 false）
 * 而 `modelsDir` 已经被缓存，这里会**先自动重新拉起**再取槽位 —— 上层不需要
 * 为了"绕开"崩溃而写重试逻辑。
 */
export async function tagPhotoBatchPixai(
  photos: PixaiTagRequest[],
  options: PixaiTagOptions = {}
): Promise<PixaiPhotoResult[]> {
  if (photos.length === 0) {
    return [];
  }
  if (!isPixaiTaggerReady()) {
    if (shuttingDown) {
      throw new Error("PixAI tagger 正在关闭");
    }
    if (!resolvedModelsDir) {
      throw new Error("PixAI tagger 未初始化（先调用 initPixaiTagger）");
    }
    // 走到这里说明 worker 崩过（或上一批超时被杀）—— 重新拉起，不静默失败
    log.warn("PixAI tagger 未就绪，自动重新拉起 worker");
    await initPixaiTagger(resolvedModelsDir, resolvedUseGpu);
  }
  const slot = await acquireSlot();
  return new Promise<PixaiPhotoResult[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      slotPending.delete(slot.index);
      // 超时的 worker 视为不可用，杀掉让下一批重新拉起（可能卡在原生层了）
      log.error(
        { index: slot.index, timeoutMs: BATCH_TIMEOUT_MS },
        "PixAI 批次超时，杀掉 worker"
      );
      slot.process.kill();
      reject(new Error(`PixAI 批次超时（${BATCH_TIMEOUT_MS} ms）`));
    }, BATCH_TIMEOUT_MS);
    slotPending.set(slot.index, { resolve, reject, timer });
    // ⚠️ thresholds 不传就不发这个字段：worker 的 DEFAULT_THRESHOLDS 与
    // `pixai-tag-categories.ts` 的 PIXAI_THRESHOLDS 一致，让它用自己的默认值
    // 才不会出现"客户端以为的阈值 ≠ 实际生效的阈值"。
    const message: Record<string, unknown> = {
      type: "tag",
      photos,
      includeEmbedding: Boolean(options.includeEmbedding),
    };
    if (options.thresholds !== undefined) {
      message.thresholds = options.thresholds;
    }
    try {
      slot.process.send(message);
    } catch (error) {
      failSlot(
        slot.index,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  });
}

/** 请求中止当前批次（worker 会在当前图片处理完后停止）。 */
export function abortPixaiTagger(): void {
  for (const slot of slots) {
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* 进程可能已退出 */
    }
  }
}

export function shutdownPixaiTagger(): void {
  shuttingDown = true;
  const closing = slots;
  slots = [];
  for (const slot of closing) {
    try {
      slot.process.send({ type: "shutdown" });
    } catch {
      /* ignore */
    }
    slot.process.kill();
  }
  for (const index of [...slotPending.keys()]) {
    failSlot(index, new Error("PixAI tagger 已关闭"));
  }
  slotPending = new Map();
  initPromise = null;
  log.info("PixAI tagger 已关闭");
}

/** 供诊断面板使用。 */
export function getPixaiTaggerState(): PixaiTaggerState {
  return {
    enabled: isEnabled(),
    modelsDir: resolvedModelsDir,
    useGpu: resolvedUseGpu,
    workers: slots.length,
    ready: isPixaiTaggerReady(),
    shuttingDown,
  };
}
