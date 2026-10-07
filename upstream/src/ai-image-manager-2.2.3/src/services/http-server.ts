import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import { PRIVATE_BUILD } from "@/config/private-build";
import {
  applyExifOrientation,
  resolveImageOrientation,
} from "@/services/image-orientation";
import {
  getCredentialRevision,
  getLanConfig,
  shouldListenOnLan,
  tempPasswordRemainingMs,
  verifyLanPassword,
} from "@/services/lan-access";
import {
  getLanPhotoFilePath,
  listLanFolders,
  listLanPhotos,
  listLanPhotosByIds,
  listLanTags,
} from "@/services/lan-api";
import { extractRawPreview, isRawFile } from "@/services/raw-preview";
import {
  findPhotoPathByDuelPreview,
  findPhotoPathByThumbnail,
  generateDuelPreview,
  generateThumbnail,
  getThumbnailPath,
  type ThumbSize,
} from "@/services/thumbnailer";
import { getDataPath } from "@/utils/data-path";
import { getFolderPaths } from "@/utils/folder-paths";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";
import { createLogger } from "@/utils/logger";
import { resolveSafePath as resolveSecurePath } from "@/utils/path-security";
import lanPageHtml from "./lan-web/index.html?raw";

const log = createLogger("http-server");

// ── 服务器实例与状态 ──────────────────────────────────────────────────

let server: http.Server | null = null;
let serverPort: number | null = null;
let isServerStarted = false;
const authToken = randomBytes(32).toString("hex");
// 保存首次分配的端口号，重启时复用，避免 renderer 持有的
// preload 注入端口（通过 --http-port）在迁移后失效。
let lastUsedPort: number | null = null;

// ── MIME 类型映射 ─────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".cr2": "image/x-canon-cr2",
  ".cr3": "image/x-canon-cr3",
  ".nef": "image/x-nikon-nef",
  ".nrw": "image/x-nikon-nrw",
  ".arw": "image/x-sony-arw",
  ".srf": "image/x-sony-srf",
  ".sr2": "image/x-sony-sr2",
  ".dng": "image/x-adobe-dng",
  ".orf": "image/x-olympus-orf",
  ".rw2": "image/x-panasonic-rw2",
  ".raf": "image/x-fujifilm-raf",
  ".pef": "image/x-pentax-pef",
  ".rwl": "image/x-leica-rwl",
  ".3fr": "image/x-hasselblad-3fr",
  ".raw": "image/x-raw",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

function getMimeType(ext: string): string {
  return MIME_TYPES[ext] ?? "image/png";
}

// ── 浏览器原生支持的图片格式 ──────────────────────────────────────────

const BROWSER_COMPATIBLE = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  ".svg",
]);

function isBrowserCompatible(ext: string): boolean {
  return BROWSER_COMPATIBLE.has(ext);
}

// ── Sharp 转换并发控制 ────────────────────────────────────────────────

class ConversionSemaphore {
  private running = 0;
  private readonly pending: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.pending.shift();
    if (next) {
      this.running++;
      next();
    }
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.pending.length;
  }
}

const conversionSemaphore = new ConversionSemaphore(4);

async function createOrientedPipeline(
  input: string | Buffer,
  originalPath: string
): Promise<ReturnType<typeof sharp>> {
  const metadata = await sharp(input, { failOn: "none" }).metadata();
  const orientation = await resolveImageOrientation(originalPath, metadata);
  return applyExifOrientation(sharp(input, { failOn: "none" }), orientation);
}

async function normalizeJpegPreview(
  preview: Buffer,
  originalPath: string
): Promise<Buffer> {
  const metadata = await sharp(preview, { failOn: "none" }).metadata();
  const orientation = await resolveImageOrientation(originalPath, metadata);
  if (orientation === 1) {
    return preview;
  }
  return await applyExifOrientation(
    sharp(preview, { failOn: "none" }),
    orientation
  )
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function serveOrientedBrowserFile(
  safePath: string,
  ext: string,
  res: http.ServerResponse
): Promise<boolean> {
  let pipeline: ReturnType<typeof sharp>;
  try {
    const metadata = await sharp(safePath, { failOn: "none" }).metadata();
    const orientation = await resolveImageOrientation(safePath, metadata);
    if (orientation === 1) {
      return false;
    }
    pipeline = applyExifOrientation(
      sharp(safePath, { failOn: "none" }),
      orientation
    );
  } catch {
    return false;
  }

  const isJpeg = ext === ".jpg" || ext === ".jpeg";
  const output = isJpeg
    ? await pipeline.jpeg({ quality: 95 }).toBuffer()
    : await pipeline.png().toBuffer();
  res.setHeader("content-type", isJpeg ? "image/jpeg" : "image/png");
  res.setHeader("cache-control", "public, max-age=86400");
  res.setHeader("content-length", output.length);
  res.writeHead(200);
  res.end(output);
  return true;
}

// ── 安全关闭响应 ──────────────────────────────────────────────────────

function safeEndError(
  res: http.ServerResponse,
  status: number,
  body: string
): void {
  if (res.headersSent) {
    res.destroy();
  } else {
    res.writeHead(status);
    res.end(body);
  }
}

// ── CORS 响应头 ───────────────────────────────────────────────────────

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null") {
    return origin === "null";
  }
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

function setCorsHeaders(res: http.ServerResponse, origin?: string): void {
  if (typeof origin !== "string" || !isAllowedOrigin(origin)) {
    return;
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
}

function isValidAuthToken(candidate: string | undefined): boolean {
  if (!candidate || candidate.length !== authToken.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(authToken));
}

function isAuthorized(
  req: http.IncomingMessage,
  searchParams: URLSearchParams
): boolean {
  const queryToken = searchParams.get("token") ?? undefined;
  const headerToken = req.headers["x-ai-image-manager-token"];
  const candidate =
    queryToken ?? (typeof headerToken === "string" ? headerToken : undefined);
  return isValidAuthToken(candidate);
}

// ── 局域网访问（自用新增）──────────────────────────────────────────────
//
// 这里刻意运行**两个**监听器，职责完全分开：
//   · "internal" —— 绑 127.0.0.1（端口由系统分配），只给渲染层用，只认进程内部 token
//   · "lan"      —— 绑 0.0.0.0:<设置里的端口>，只给手机/平板用，只认登录会话
//
// 为什么不是"一个监听器按开关切换监听地址"（实施计划最初的想法）：
//   渲染层的端口是**创建窗口时通过 `--http-port` 注入**的。如果本机端口和局域网
//   端口是同一个，用户在设置里改端口就会把渲染层脚下的端口搬走，
//   所有缩略图立刻失效（要重启应用才能恢复）。拆成两个之后：
//     - 局域网端口随便改、随便重启，渲染层完全不受影响；
//     - 本机监听器永远只在 127.0.0.1 上，**不会**被局域网访问到；
//     - 局域网口的媒体请求一律要口令，本机口一律不要口令（它有自己的 token）。
//
// ⚠️ 局域网侧**永远不提供**任何设置类接口（端口/口令/开关）。将来加接口时，
//    不要图省事把 `getLanConfig()` 的结果塞进任何 HTTP 响应里。

type ListenMode = "internal" | "lan";

const LAN_SESSION_COOKIE = "aim_lan_session";
/** 会话最长存活时间（30 天）。*/
const LAN_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 同时保留的会话数上限（超出时淘汰最旧的）。*/
const LAN_SESSION_LIMIT = 64;
/** 登录失败限流：时间窗内最多允许的失败次数。*/
const LAN_LOGIN_FAILURE_LIMIT = 10;
const LAN_LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** 登录请求体上限，避免有人塞一个巨大的 body。*/
const LAN_LOGIN_BODY_LIMIT = 4096;

interface LanSession {
  expiresAt: number;
  /** 签发时的口令版本号；口令一改，旧会话全部作废。*/
  revision: string;
}

const lanSessions = new Map<string, LanSession>();
const lanLoginFailures = new Map<string, { count: number; resetAt: number }>();

let lanServer: http.Server | null = null;
let lanServerPort: number | null = null;
let lanListenError: LanListenError | null = null;
/** 当前已生效的局域网监听签名，用来判断是否需要重建监听器。*/
let lanAppliedSignature = "";
/** syncLanListener() 的串行化链（见该函数的注释）。*/
let lanSyncChain: Promise<void> = Promise.resolve();

/**
 * 监听失败的信息。
 *
 * `code` 交给界面做本地化（例如 EADDRINUSE → "端口被占用"），
 * `message` 只是给日志和兜底显示用的英文原文。
 */
export interface LanListenError {
  code: string;
  message: string;
}

export interface LanListenerStatus {
  /** 真的在 0.0.0.0 上监听了吗。*/
  active: boolean;
  /** 监听失败的原因（端口被占用等）；成功时为 null。*/
  error: LanListenError | null;
  /** 实际监听的端口。*/
  port: number | null;
}

/** 清掉过期、以及口令已变更而失效的会话。*/
function pruneLanSessions(now: number): void {
  const revision = getCredentialRevision();
  for (const [token, session] of lanSessions) {
    if (session.expiresAt <= now || session.revision !== revision) {
      lanSessions.delete(token);
    }
  }
}

function createLanSession(ttlMs: number): string {
  const now = Date.now();
  pruneLanSessions(now);
  const token = randomBytes(32).toString("hex");
  lanSessions.set(token, {
    expiresAt: now + ttlMs,
    revision: getCredentialRevision(),
  });
  while (lanSessions.size > LAN_SESSION_LIMIT) {
    const oldest = lanSessions.keys().next();
    if (oldest.done) {
      break;
    }
    lanSessions.delete(oldest.value);
  }
  return token;
}

function isLanSessionValid(token: string | null): boolean {
  if (!token) {
    return false;
  }
  const session = lanSessions.get(token);
  if (!session) {
    return false;
  }
  if (
    session.expiresAt <= Date.now() ||
    session.revision !== getCredentialRevision()
  ) {
    lanSessions.delete(token);
    return false;
  }
  return true;
}

function readCookie(
  cookieHeader: string | undefined,
  name: string
): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function lanLoginAllowed(ip: string): boolean {
  const entry = lanLoginFailures.get(ip);
  if (!entry) {
    return true;
  }
  if (entry.resetAt <= Date.now()) {
    lanLoginFailures.delete(ip);
    return true;
  }
  return entry.count < LAN_LOGIN_FAILURE_LIMIT;
}

function recordLanLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = lanLoginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    lanLoginFailures.set(ip, {
      count: 1,
      resetAt: now + LAN_LOGIN_FAILURE_WINDOW_MS,
    });
    return;
  }
  entry.count += 1;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LAN_LOGIN_BODY_LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** `GET /health` —— 唯一不需要口令的端点，且**只**回答"活着"。*/
function handleHealth(res: http.ServerResponse): void {
  // ⚠️ 不要在这里加版本号、端口、开关等任何东西（"局域网不给看设置"）。
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));
}

// ── 手机网页（阶段 4）────────────────────────────────────────────────
//
// 网页本体用 `?raw` 在**构建时内联**进主进程 bundle —— 这样打包后不需要额外
// 往 resources 里塞 html 文件，也不会出现"开发时能开、装完就 404"的经典问题。
//
// ⚠️ 这一屏是**免鉴权**的（否则手机连登录界面都打不开），
//    所以它里面**不能有任何数据** —— 数据一律靠登录后的 `/api/*` 取。
const LAN_PAGE_PATHS = new Set(["/", "/index.html", "/m"]);
const LAN_PAGE_BUFFER = Buffer.from(lanPageHtml, "utf8");

function serveLanPage(res: http.ServerResponse): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("content-length", LAN_PAGE_BUFFER.length);
  // no-cache：改了页面刷新就能看到，不至于把旧版页面留在手机上
  res.setHeader("cache-control", "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  // 页面自己就是全部资源（没有外链字体/脚本），所以 CSP 可以收得很紧：
  // 只允许同源、不许被 iframe 嵌套、不许提交表单。
  // script/style 需要 'unsafe-inline'（整页是单文件，内联脚本与样式）。
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.writeHead(200);
  res.end(LAN_PAGE_BUFFER);
}

/** `POST /api/login` —— 用口令换一个会话 Cookie。*/
async function handleLanLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";

  if (!lanLoginAllowed(ip)) {
    res.setHeader(
      "retry-after",
      String(Math.ceil(LAN_LOGIN_FAILURE_WINDOW_MS / 1000))
    );
    safeEndError(res, 429, "Too Many Requests");
    log.warn(`[LAN] login rate-limited from ${ip}`);
    return;
  }

  let password: string | null = null;
  try {
    const body = await readJsonBody(req);
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { password?: unknown }).password === "string"
    ) {
      password = (body as { password: string }).password;
    }
  } catch {
    safeEndError(res, 400, "Bad Request");
    return;
  }

  if (password === null) {
    recordLanLoginFailure(ip);
    safeEndError(res, 401, "Unauthorized");
    return;
  }

  // ⚠️ verifyLanPassword 内部是 scrypt（故意慢，几十毫秒）。
  //    **只在这里调用**；其余请求一律走会话，不要在每个缩略图上跑它。
  const result = verifyLanPassword(password);
  if (!result.ok) {
    recordLanLoginFailure(ip);
    log.warn(`[LAN] login failed from ${ip}`);
    // ⚠️ 不区分"口令错误"和"临时口令已过期"，一律 401。
    safeEndError(res, 401, "Unauthorized");
    return;
  }

  lanLoginFailures.delete(ip);

  // 临时口令换来的会话不能活得比口令本身更久。
  const ttlMs =
    result.kind === "temp"
      ? Math.min(
          LAN_SESSION_MAX_AGE_MS,
          Math.max(60_000, tempPasswordRemainingMs())
        )
      : LAN_SESSION_MAX_AGE_MS;

  const token = createLanSession(ttlMs);
  res.setHeader(
    "set-cookie",
    `${LAN_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`
  );
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.writeHead(200);
  // 只回 ok，不回是哪种口令（没必要让客户端知道）。
  res.end(JSON.stringify({ ok: true }));
  log.info(`[LAN] login ok from ${ip} (${result.kind})`);
}

/** `POST /api/logout` —— 丢掉会话（幂等）。*/
function handleLanLogout(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  const token = readCookie(req.headers.cookie, LAN_SESSION_COOKIE);
  if (token) {
    lanSessions.delete(token);
  }
  res.setHeader(
    "set-cookie",
    `${LAN_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
  res.writeHead(204);
  res.end();
}

/* ── 识图（以图搜图）────────────────────────────────────────────────
 *
 * 这是局域网侧**唯一**接受请求体的接口。它不修改图库：只把上传的图片算成
 * 特征向量，再去向量库检索最像的照片。安全措施（缺一不可）：
 *   · 必须已登录（走局域网会话，handleLanApi 之前已鉴权）
 *   · 只收图片 MIME，大小上限 8 MB
 *   · 落到临时文件后**立刻用后即删**，不在磁盘上留用户的图
 *   · 按来源限流（每次都要跑一次特征提取，属于实打实的 CPU 开销）
 *   · AI 未就绪时回 503，**不假装"没找到"**
 */

const LAN_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const LAN_UPLOAD_RESULT_LIMIT = 60;
const LAN_UPLOAD_LIMIT = 10;
const LAN_UPLOAD_WINDOW_MS = 60_000;
const lanUploadUsage = new Map<string, { count: number; resetAt: number }>();

const UPLOAD_MIME_EXTENSIONS: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

function readBinaryBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        // 超限之后继续把剩余数据读掉（丢弃），但**不要断开连接** ——
        // 断开会变成"连接重置"，客户端就收不到我们想回的 413 了。
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const error = new Error("payload too large") as NodeJS.ErrnoException;
        error.code = "E_TOO_LARGE";
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function handleLanSearchByImage(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const usage = lanUploadUsage.get(ip);
  if (usage && usage.resetAt > now && usage.count >= LAN_UPLOAD_LIMIT) {
    res.setHeader(
      "retry-after",
      String(Math.ceil(LAN_UPLOAD_WINDOW_MS / 1000))
    );
    sendJson(res, 429, { error: "too_many_requests" });
    log.warn(`[LAN] 识图被限流：${ip}`);
    return;
  }

  const contentType = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const extension = UPLOAD_MIME_EXTENSIONS[contentType];
  if (!extension) {
    sendJson(res, 415, { error: "unsupported_media_type" });
    return;
  }

  let body: Buffer;
  try {
    body = await readBinaryBody(req, LAN_UPLOAD_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "E_TOO_LARGE") {
      sendJson(res, 413, {
        error: "payload_too_large",
        maxBytes: LAN_UPLOAD_MAX_BYTES,
      });
      return;
    }
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, { error: "empty_body" });
    return;
  }

  if (!usage || usage.resetAt <= now) {
    lanUploadUsage.set(ip, { count: 1, resetAt: now + LAN_UPLOAD_WINDOW_MS });
  } else {
    usage.count += 1;
  }

  const { isAiSearchReady, searchByImage } = await import(
    "@/services/ai/search"
  );
  if (!isAiSearchReady()) {
    sendJson(res, 503, { error: "ai_not_ready" });
    return;
  }

  const tmpDir = path.join(getDataPath(), "lan-upload-tmp");
  const tmpFile = path.join(
    tmpDir,
    `${now}-${randomBytes(6).toString("hex")}${extension}`
  );

  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.writeFile(tmpFile, body);
    const hits = await searchByImage(tmpFile, LAN_UPLOAD_RESULT_LIMIT);
    const items = listLanPhotosByIds(
      hits.map((hit) => hit.photoId),
      LAN_UPLOAD_RESULT_LIMIT
    );
    sendJson(res, 200, {
      items,
      limit: LAN_UPLOAD_RESULT_LIMIT,
      mode: "image",
      total: items.length,
    });
    log.info(`[LAN] 识图完成：${ip} → ${items.length} 张`);
  } catch (error) {
    // 该报就报：识图失败要说清楚，不要回一个空列表让人以为是"没找到"
    log.error(
      `[LAN] 识图失败：${(error as Error)?.message ?? String(error)}`
    );
    if (!res.headersSent) {
      sendJson(res, 500, { error: "search_failed" });
    }
  } finally {
    // 用户的图**绝不留在磁盘上**
    fs.promises.rm(tmpFile, { force: true }).catch(() => undefined);
  }
}

/**
 * 让局域网监听器与当前设置保持一致（开关 + 口令 + 端口）。
 *
 * 幂等：已经在目标端口上监听时直接返回。设置页每次改动都会调它，
 * 所以"改端口/开关"**不需要重启应用**。
 *
 * ⚠️ 必须**串行化**：应用启动时会同时从"早期启动"和"注册表启动"两条路径调进来，
 *    两个调用并发跑会各自 bind 同一个端口 → 一个成功一个 EADDRINUSE，
 *    失败的那个还会把成功的那个从状态里抹掉。这里用一条 Promise 链排队。
 */
export function syncLanListener(): Promise<void> {
  const next = lanSyncChain.then(
    () => syncLanListenerInner(),
    () => syncLanListenerInner()
  );
  // 链本身不允许残留 rejection，否则后续调用会被短路。
  lanSyncChain = next.catch(() => undefined);
  return next;
}

async function syncLanListenerInner(): Promise<void> {
  let enabled = false;
  let port = 0;
  try {
    // ⚠️ startHttpServerEarly() 跑在应用启动的很早期，那时候数据库**可能还没就绪**
    //    （getLanConfig() 要读 app_settings）。读不到就当"不开启"，绝不能把启动搞崩；
    //    注册表里 database 之后会再调一次本函数。
    enabled = PRIVATE_BUILD.enableLanAccess && shouldListenOnLan();
    port = enabled ? getLanConfig().port : 0;
  } catch (error) {
    log.warn(
      `[LAN] 读取局域网设置失败（可能数据库尚未就绪），稍后再试：${(error as Error)?.message ?? String(error)}`
    );
    return;
  }
  const signature = enabled ? `0.0.0.0:${port}` : "";

  // 已经是目标状态（失败时 lanServer 为 null，会继续往下重试）。
  if (signature === lanAppliedSignature && (!enabled || lanServer)) {
    return;
  }

  await closeLanListener();
  lanListenError = null;

  if (!enabled) {
    // 只在**真的从开着变成关着**时留痕，避免每次设置页改动都刷日志。
    if (lanAppliedSignature !== "") {
      log.info("[LAN] 已停止局域网监听（功能关闭，或缺少永久口令）");
    }
    lanAppliedSignature = "";
    return;
  }

  await new Promise<void>((resolve) => {
    const candidate = http.createServer((req, res) =>
      handleRequest(req, res, "lan")
    );
    candidate.on("error", (err: NodeJS.ErrnoException) => {
      lanListenError = {
        code: err.code ?? "UNKNOWN",
        message: err.message || String(err),
      };
      log.warn(
        `[LAN] 监听 0.0.0.0:${port} 失败：${lanListenError.code} ${lanListenError.message}（本机功能不受影响）`
      );
      lanServer = null;
      lanServerPort = null;
      candidate.close();
      resolve();
    });
    candidate.listen(port, "0.0.0.0", () => {
      const address = candidate.address();
      lanServer = candidate;
      lanServerPort =
        address && typeof address === "object" ? address.port : port;
      lanListenError = null;
      lanAppliedSignature = signature;
      log.info(
        `[LAN] 已监听 0.0.0.0:${lanServerPort}（局域网设备用浏览器访问 http://<本机IP>:${lanServerPort}/）`
      );
      resolve();
    });
  });
}

function closeLanListener(): Promise<void> {
  const current = lanServer;
  lanServer = null;
  lanServerPort = null;
  if (!current) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    current.close(() => resolve());
    // 手机端多半带着 keep-alive 连接，不主动断开的话 close() 会一直等下去。
    current.closeAllConnections();
  });
}

export function getLanListenerStatus(): LanListenerStatus {
  return {
    active: lanServer !== null,
    error: lanListenError,
    port: lanServerPort,
  };
}

// ── 路径安全校验 ──────────────────────────────────────────────────────

function resolveSafePath(targetPath: string): string | null {
  const allowedRoots = [getDataPath(), ...getFolderPaths()];
  return resolveSecurePath(targetPath, allowedRoots);
}

// ── 路由：GET /thumbnail ──────────────────────────────────────────────
// 三阶段处理：
//   Phase A — 文件存在且有效 → 直接流式返回
//   Phase B — 文件缺失 (ENOENT) 或损坏 → 按需重新生成后返回
// 重试按钮（前端 ?retry=N 参数）和缓存淘汰后均自动恢复。

function serveStaticFile(
  filePath: string,
  res: http.ServerResponse,
  mimeType: string,
  immutable: boolean
): void {
  fs.promises
    .stat(filePath)
    .then((stats) => {
      if (!stats.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return;
      }

      res.setHeader("content-type", mimeType);
      res.setHeader(
        "cache-control",
        immutable
          ? "public, max-age=31536000, immutable"
          : "public, max-age=86400"
      );
      res.setHeader("content-length", stats.size);
      res.writeHead(200);

      const readStream = fs.createReadStream(filePath);
      readStream.on("error", (err) => {
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        log.warn(
          `[HttpServer] stream error for ${filePath}: ${(err as Error)?.message ?? String(err)}`
        );
      });
      readStream.pipe(res);
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (!res.headersSent) {
        const code = err?.code;
        if (code === "ENOENT") {
          res.writeHead(404);
          res.end("Not Found");
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        log.warn(
          `[HttpServer] stat error for ${filePath}: ${(err as Error)?.message ?? String(err)}`
        );
      }
    });
}

// ── 按需重新生成辅助函数 ────────────────────────────────────────────────

async function regenerateAndServeThumbnail(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  recordGalleryMediaStat("thumbnailRegenerate");
  try {
    const lookup = findPhotoPathByThumbnail(safePath);
    if (!lookup) {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end("Not Found");
      }
      log.warn(
        `[HttpServer] /thumbnail orphaned, no original photo: ${safePath}`
      );
      return;
    }

    log.info(
      `[HttpServer] /thumbnail regenerating: ${path.basename(safePath)} → ${lookup.photoPath} (${lookup.size})`
    );

    const result = await generateThumbnail(lookup.photoPath, lookup.size);
    serveStaticFile(result.thumbnailPath, res, "image/webp", true);
  } catch (regenerateErr) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Thumbnail regeneration failed");
    }
    log.warn(
      `[HttpServer] /thumbnail regeneration failed for ${safePath}: ${(regenerateErr as Error)?.message ?? String(regenerateErr)}`
    );
  }
}

async function regenerateAndServeDuelPreview(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  try {
    const photoPath = findPhotoPathByDuelPreview(safePath);
    if (!photoPath) {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end("Not Found");
      }
      log.warn(
        `[HttpServer] /duel-preview orphaned, no original photo: ${safePath}`
      );
      return;
    }

    log.info(
      `[HttpServer] /duel-preview regenerating: ${path.basename(safePath)} → ${photoPath}`
    );

    const result = await generateDuelPreview(photoPath);
    if (!result) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Duel preview generation returned null");
      }
      return;
    }

    serveStaticFile(result.previewPath, res, "image/jpeg", true);
  } catch (regenerateErr) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Duel preview regeneration failed");
    }
    log.warn(
      `[HttpServer] /duel-preview regeneration failed for ${safePath}: ${(regenerateErr as Error)?.message ?? String(regenerateErr)}`
    );
  }
}

async function handleThumbnail(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  setCorsHeaders(res);
  recordGalleryMediaStat("thumbnailRequest");

  // Phase A: Try to serve existing file (with integrity validation)
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
      return;
    }
    // File not found → Phase B
    stats = null as unknown as fs.Stats;
  }

  if (stats?.isFile()) {
    // Validate integrity: sharp.metadata() on a corrupt file will throw
    try {
      await sharp(safePath).metadata();
    } catch {
      // Corrupt file → delete and fall through to regeneration
      log.warn(`[HttpServer] /thumbnail corrupt file, deleting: ${safePath}`);
      await fs.promises.unlink(safePath).catch(() => {
        /* best-effort deletion */
      });
      stats = null as unknown as fs.Stats; // trigger Phase B
    }
  }

  if (stats?.isFile()) {
    // Valid file → serve
    recordGalleryMediaStat("thumbnailHit");
    const diskExt = path.extname(safePath).toLowerCase();
    serveStaticFile(safePath, res, getMimeType(diskExt), true);
    return;
  }

  // Phase B: On-demand regeneration
  await regenerateAndServeThumbnail(safePath, res);
}

/** /duel-preview 路由 — 预生成的 2560px JPEG 对比预览（PK 选片专用）。
 *  文件缺失或损坏时自动触发重新生成。 */
async function handleDuelPreview(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  setCorsHeaders(res);

  // Phase A: Try to serve existing file (with integrity validation)
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (code === "ENOENT") {
      stats = null as unknown as fs.Stats; // Phase B
    } else {
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }
  }

  if (stats?.isFile()) {
    try {
      await sharp(safePath).metadata();
    } catch {
      log.warn(
        `[HttpServer] /duel-preview corrupt file, deleting: ${safePath}`
      );
      await fs.promises.unlink(safePath).catch(() => {
        /* best-effort deletion */
      });
      stats = null as unknown as fs.Stats;
    }
  }

  if (stats?.isFile()) {
    serveStaticFile(safePath, res, "image/jpeg", true);
    return;
  }

  // Phase B: On-demand regeneration
  await regenerateAndServeDuelPreview(safePath, res);
}

// ── 路由：GET /preview ────────────────────────────────────────────────

async function handlePreview(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  setCorsHeaders(res);

  const ext = path.extname(safePath).toLowerCase();

  if (!isRawFile(safePath)) {
    log.warn(
      `[HttpServer] /preview rejected: not a RAW file — ext=${ext} path=${safePath}`
    );
    res.writeHead(404);
    res.end("Not a RAW file");
    return;
  }

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log.error(
      `[HttpServer] /preview stat failed: path=${safePath} code=${code} message=${(err as Error).message}`
    );
    if (!res.headersSent) {
      res.writeHead(code === "ENOENT" ? 404 : 500);
      res.end(code === "ENOENT" ? "Not Found" : "Internal Server Error");
    }
    return;
  }

  if (!stats.isFile()) {
    log.warn(
      `[HttpServer] /preview rejected: path is not a file — path=${safePath}`
    );
    res.writeHead(404);
    res.end("Not a file");
    return;
  }

  log.info(
    `[HttpServer] /preview extracting: path=${safePath} size=${stats.size} ext=${ext}`
  );

  let preview: Buffer | null = null;
  const extractStart = Date.now();

  try {
    preview = await extractRawPreview(safePath);
  } catch (err) {
    log.error(
      `[HttpServer] /preview extractRawPreview THREW: path=${safePath} error=${(err as Error).message} stack=${(err as Error).stack}`
    );
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Preview extraction failed");
    }
    return;
  }

  const extractMs = Date.now() - extractStart;

  if (!preview) {
    log.warn(
      `[HttpServer] /preview returned null — all 4 extraction stages failed. path=${safePath} ext=${ext} size=${stats.size} elapsed=${extractMs}ms`
    );
    res.writeHead(404);
    res.end("No embedded preview available");
    return;
  }

  if (preview.length === 0) {
    log.error(
      `[HttpServer] /preview returned EMPTY buffer — length=0. path=${safePath} elapsed=${extractMs}ms`
    );
    res.writeHead(404);
    res.end("No embedded preview available");
    return;
  }

  log.info(
    `[HttpServer] /preview OK: path=${safePath} size=${preview.length} bytes elapsed=${extractMs}ms`
  );

  preview = await normalizeJpegPreview(preview, safePath);

  res.setHeader("content-type", "image/jpeg");
  res.setHeader("cache-control", "public, max-age=86400");
  res.setHeader("content-length", preview.length);
  res.writeHead(200);
  res.end(preview);
}

// ── 路由：GET /image ──────────────────────────────────────────────────
// RAW → extractRawPreview (不走 sharp)，browser-compatible → 直接流式，
// HEIC/TIFF 等 → sharp({failOn:"none"}).png().pipe(res) 并发上限 4。

function handleImage(
  safePath: string,
  res: http.ServerResponse,
  req: http.IncomingMessage
): void {
  setCorsHeaders(res);

  fs.promises
    .stat(safePath)
    .then(async (stats) => {
      if (!stats.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return;
      }

      const ext = path.extname(safePath).toLowerCase();

      // ── 路径 1：RAW 格式 → extractRawPreview 提取内嵌 JPEG ──
      // 旧 local-media:// 协议从未将 RAW 传给 sharp。
      // Sharp 的预编译 libvips 不含专有 RAW 解码器（CR2/NEF 等），
      // 强行传入会导致 "compression method is not configured" 致命错误。
      if (isRawFile(safePath)) {
        log.info(
          `[HttpServer] /image RAW → extractRawPreview: path=${safePath} ext=${ext}`
        );

        const extractStart = Date.now();
        let preview: Buffer | null = null;

        try {
          preview = await extractRawPreview(safePath);
        } catch (err) {
          log.error(
            `[HttpServer] /image extractRawPreview THREW: path=${safePath} error=${(err as Error).message}`
          );
          safeEndError(res, 500, "Preview extraction failed");
          return;
        }

        if (!preview || preview.length === 0) {
          log.error(
            `[HttpServer] /image extractRawPreview failed: path=${safePath} elapsed=${Date.now() - extractStart}ms`
          );
          safeEndError(res, 500, "No embedded preview available");
          return;
        }

        log.info(
          `[HttpServer] /image RAW preview OK: path=${safePath} size=${preview.length} bytes elapsed=${Date.now() - extractStart}ms`
        );

        preview = await normalizeJpegPreview(preview, safePath);

        res.setHeader("content-type", "image/jpeg");
        res.setHeader("cache-control", "public, max-age=86400");
        res.setHeader("content-length", preview.length);
        res.writeHead(200);
        res.end(preview);
        return;
      }

      // ── 路径 2：浏览器原生兼容 → 直接流式输出 ──────────────
      if (isBrowserCompatible(ext)) {
        if (await serveOrientedBrowserFile(safePath, ext, res)) {
          return;
        }

        const mimeType = getMimeType(ext);
        res.setHeader("content-type", mimeType);
        res.setHeader("cache-control", "public, max-age=86400");
        res.setHeader("content-length", stats.size);
        res.writeHead(200);

        const readStream = fs.createReadStream(safePath);

        readStream.on("error", (err) => {
          if (res.headersSent) {
            res.destroy();
          } else {
            res.writeHead(500);
            res.end("Internal Server Error");
          }
          log.warn(
            `[HttpServer] /image static stream error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
          );
        });

        readStream.pipe(res);
        return;
      }

      // ── 路径 3：其他需转换格式 (HEIC/TIFF/…) → sharp 流式转换 ──
      // 受并发信号量保护，上限 4 个同时转换。
      log.info(
        `[HttpServer] /image converting via sharp: path=${safePath} ext=${ext} size=${stats.size}`
      );

      conversionSemaphore.acquire().then(async () => {
        if (res.destroyed) {
          conversionSemaphore.release();
          return;
        }

        let slotReleased = false;

        const releaseSlot = () => {
          if (!slotReleased) {
            slotReleased = true;
            conversionSemaphore.release();
          }
        };

        res.on("finish", releaseSlot);
        res.on("close", releaseSlot);
        res.on("error", releaseSlot);
        req.on("close", () => {
          setTimeout(releaseSlot, 100);
        });

        // 不在此处 res.writeHead(200)。由 pipe() 在首个数据块到达时
        // 自动发送响应头。若 sharp 流在产出数据前报错，headersSent 仍为
        // false，可 writeHead(500).end() 正常关闭，杜绝 ERR_EMPTY_RESPONSE。
        res.setHeader("content-type", "image/png");
        res.setHeader("cache-control", "public, max-age=86400");

        try {
          const sharpStream = (
            await createOrientedPipeline(safePath, safePath)
          ).png();

          sharpStream.on("error", (err: Error) => {
            releaseSlot();
            if (res.headersSent) {
              // 已经向浏览器发送了部分 PNG 数据，无法再发送错误页。
              // 只能销毁连接。
              res.destroy();
            } else {
              // 尚未发送任何数据 — 正常返回 500 错误页，
              // 杜绝 ERR_EMPTY_RESPONSE。
              res.writeHead(500);
              res.end("Image conversion failed");
            }
            log.error(
              `[HttpServer] /image sharp conversion error for ${safePath}: ${err.message}`
            );
          });

          sharpStream.pipe(res);
        } catch (err) {
          releaseSlot();
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Image conversion failed");
          }
          log.error(
            `[HttpServer] /image sharp init error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
          );
        }
      });
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (!res.headersSent) {
        const code = err?.code;
        if (code === "ENOENT") {
          res.writeHead(404);
          res.end("Not Found");
        } else if (code === "EACCES" || code === "EPERM") {
          res.writeHead(403);
          res.end("Forbidden");
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      }
    });
}

// ── 只读检索 API（自用新增，阶段 3）────────────────────────────────────
//
// **只服务手机端"全部照片"那一屏**（用户明确收窄过范围）：
//   GET /api/photos?q=&sort=&order=&limit=&offset=   照片列表（带搜索）
//   GET /api/photo/<id>/thumb?size=sm|md|lg          缩略图
//   GET /api/photo/<id>/image                        原图（浏览器直接看）
//   GET /api/photo/<id>/download                     下载原图（支持 Range）
// 收藏 / 文件夹树 / 标签树 / 详情 / 以图搜图 / 任何写操作 —— 都没有对应路由。
//
// ⚠️ 这些响应里**不许**出现磁盘路径，也不许出现 `lan-access.ts` 的任何字段。
//    照片一律用 `/api/photo/<id>/...` 的相对 URL 引用，路径由服务端自己查。

const API_PHOTO_ROUTE_RE = /^\/api\/photo\/(\d+)\/(thumb|image|download)$/;

/**
 * 磁盘路径的形态：`C:\...` 或 `\\server\share`。
 *
 * 文件名在 NTFS 上不可能含 `\`，标签名也不会长成这样，
 * 所以这个正则命中就意味着**真的漏了路径**，可以放心拦截。
 */
const ABSOLUTE_PATH_RE = /[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\/;

/**
 * 统一的 JSON 响应出口 —— 顺便当**防泄漏闸门**。
 *
 * 局域网侧不许出现磁盘路径（见文件头第 3 条）。与其靠人眼 review
 * `lan-api.ts` 的字段白名单，不如在这里统一拦一道：真漏了就大声报错并回 500，
 * **宁可这个接口坏掉，也不要悄悄把用户的目录结构发给手机**。
 */
function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown
): void {
  let body: Buffer;
  try {
    const text = JSON.stringify(payload) ?? "null";
    if (ABSOLUTE_PATH_RE.test(text)) {
      log.error(
        "[LAN] 响应里出现了磁盘路径，已拦截 —— 这是 bug，请检查 lan-api.ts 的字段白名单"
      );
      const fallback = Buffer.from(
        JSON.stringify({ error: "internal_error" }),
        "utf8"
      );
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("content-length", fallback.length);
      res.setHeader("cache-control", "no-store");
      res.writeHead(500);
      res.end(fallback);
      return;
    }
    body = Buffer.from(text, "utf8");
  } catch (error) {
    log.error(
      `[LAN] 响应序列化失败：${(error as Error)?.message ?? String(error)}`
    );
    body = Buffer.from(JSON.stringify({ error: "internal_error" }), "utf8");
  }
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", body.length);
  // 数据接口一律不缓存：手机刷新就要看到最新结果
  res.setHeader("cache-control", "no-store");
  res.writeHead(status);
  res.end(body);
}

function readIntParam(
  searchParams: URLSearchParams,
  name: string
): number | undefined {
  const raw = searchParams.get(name);
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function readBoolParam(
  searchParams: URLSearchParams,
  name: string
): boolean | undefined {
  const raw = searchParams.get(name);
  if (raw === null) {
    return undefined;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

function readSortParam(
  searchParams: URLSearchParams
): "date" | "name" | "size" | undefined {
  const raw = searchParams.get("sort");
  if (raw === "name" || raw === "size" || raw === "date") {
    return raw;
  }
  return undefined;
}

function readOrderParam(
  searchParams: URLSearchParams
): "asc" | "desc" | undefined {
  const raw = searchParams.get("order");
  return raw === "asc" || raw === "desc" ? raw : undefined;
}

function readThumbSize(raw: string | null): ThumbSize {
  return raw === "sm" || raw === "lg" ? raw : "md";
}

/**
 * 解析单区间 `Range` 头。
 *
 * 多区间（`bytes=0-9,20-29`）与语法不合法的值一律返回 null → 退化成 200 全量，
 * 浏览器能正常处理；只支持单区间已经够手机断点续传/拖进度用。
 */
function parseSingleRange(
  header: string,
  size: number
): { end: number; start: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }
  let start: number;
  let end: number;
  if (rawStart === "") {
    // 后缀区间：最后 N 字节
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!(Number.isFinite(start) && Number.isFinite(end))) {
    return null;
  }
  if (start > end || start >= size) {
    return null;
  }
  return { end: Math.min(end, size - 1), start: Math.max(0, start) };
}

/**
 * 直接发磁盘文件，支持 Range 与"另存为"文件名。
 *
 * 用于**下载原图**（发原始字节，不做任何转换 —— 用户要的是"保存这张图"）。
 */
function serveFileWithRange(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  mimeType: string,
  downloadName?: string
): void {
  fs.promises
    .stat(filePath)
    .then((stats) => {
      if (!stats.isFile()) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      res.setHeader("accept-ranges", "bytes");
      res.setHeader("content-type", mimeType);
      if (downloadName) {
        // RFC 5987：文件名可能是中文，必须用 filename* 传
        res.setHeader(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
        );
      }

      const range = req.headers.range;
      const parsed = range ? parseSingleRange(range, stats.size) : null;
      const start = parsed ? parsed.start : 0;
      const end = parsed ? parsed.end : stats.size - 1;

      if (parsed) {
        res.setHeader("content-range", `bytes ${start}-${end}/${stats.size}`);
      }
      res.setHeader("content-length", end - start + 1);
      res.writeHead(parsed ? 206 : 200);

      const stream = fs.createReadStream(filePath, { end, start });
      stream.on("error", (err) => {
        if (res.headersSent) {
          res.destroy();
        } else {
          sendJson(res, 500, { error: "read_failed" });
        }
        log.warn(
          `[HttpServer] 下载流错误 ${filePath}: ${(err as Error)?.message ?? String(err)}`
        );
      });
      stream.pipe(res);
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (!res.headersSent) {
        sendJson(res, err?.code === "ENOENT" ? 404 : 500, {
          error: err?.code === "ENOENT" ? "not_found" : "internal_error",
        });
      }
      log.warn(
        `[HttpServer] 下载 stat 失败 ${filePath}: ${(err as Error)?.message ?? String(err)}`
      );
    });
}

/**
 * 处理 `/api/*`。返回 true 表示这个请求已经被接管。
 *
 * 注意：调用点已经做过鉴权（局域网侧要会话、本机侧要内部 token），
 * 所以这里不再重复判断身份。
 */
function handleLanApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams
): boolean {
  // 识图是这里唯一的 POST；其余 API 一律只读 GET。
  if (pathname === "/api/search-by-image") {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      safeEndError(res, 405, "Method Not Allowed");
      return true;
    }
    void handleLanSearchByImage(req, res);
    return true;
  }

  const photoMatch = API_PHOTO_ROUTE_RE.exec(pathname);
  const isListRoute =
    pathname === "/api/photos" ||
    pathname === "/api/folders" ||
    pathname === "/api/tags";
  if (!(photoMatch || isListRoute)) {
    return false;
  }

  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    safeEndError(res, 405, "Method Not Allowed");
    return true;
  }

  try {
    if (pathname === "/api/folders") {
      sendJson(res, 200, { items: listLanFolders() });
      return true;
    }

    if (pathname === "/api/tags") {
      sendJson(res, 200, { items: listLanTags() });
      return true;
    }

    if (pathname === "/api/photos") {
      // 搜索走语义链路（和桌面一致），所以这里是异步的。
      listLanPhotos({
        favoriteOnly: readBoolParam(searchParams, "favorite"),
        folderId: readIntParam(searchParams, "folderId"),
        limit: readIntParam(searchParams, "limit"),
        offset: readIntParam(searchParams, "offset"),
        order: readOrderParam(searchParams),
        search: searchParams.get("q") ?? undefined,
        sort: readSortParam(searchParams),
        tagId: readIntParam(searchParams, "tagId"),
      }).then(
        (result) => sendJson(res, 200, result),
        (error: unknown) => {
          // 该报就报（坑 #5），并且明确回一个 500 而不是空列表
          log.error(
            `[LAN] 照片列表查询失败：${(error as Error)?.message ?? String(error)}`
          );
          if (!res.headersSent) {
            sendJson(res, 500, { error: "list_failed" });
          }
        }
      );
      return true;
    }

    const id = Number.parseInt((photoMatch as RegExpExecArray)[1], 10);
    const action = (photoMatch as RegExpExecArray)[2];

    const file = getLanPhotoFilePath(id);
    if (!file) {
      sendJson(res, 404, { error: "not_found" });
      return true;
    }

    if (action === "thumb") {
      // 复用现有缩略图逻辑：缓存文件不在就按需重新生成
      handleThumbnail(
        getThumbnailPath(file.path, readThumbSize(searchParams.get("size"))),
        res
      );
      return true;
    }

    const safePath = resolveSafePath(file.path);
    if (!safePath) {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }

    if (action === "image") {
      handleImage(safePath, res, req);
      return true;
    }

    // download：发**原始字节**（不转码），浏览器按附件保存
    serveFileWithRange(
      req,
      res,
      safePath,
      getMimeType(path.extname(safePath).toLowerCase()),
      file.filename
    );
    return true;
  } catch (error) {
    log.error(
      `[LAN] API 处理失败 ${pathname}：${(error as Error)?.message ?? String(error)}`
    );
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error" });
    } else {
      res.destroy();
    }
    return true;
  }
}

// ── 请求分发 ──────────────────────────────────────────────────────────

/** 四个媒体路由共用的前缀判断。*/
const MEDIA_ROUTES = new Set([
  "/thumbnail",
  "/preview",
  "/image",
  "/duel-preview",
]);

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mode: ListenMode = "internal"
): void {
  let pathname: string;
  let searchParams: URLSearchParams;

  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    pathname = url.pathname;
    searchParams = url.searchParams;
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  // ── ① 不需要登录的端点 ──────────────────────────────────────────
  // 只有"你连上了吗"、"登录"本身、以及**不含任何数据**的手机网页外壳。
  // 这里**不许**放任何会回吐配置或数据的接口。
  if (LAN_PAGE_PATHS.has(pathname)) {
    serveLanPage(res);
    return;
  }
  if (pathname === "/favicon.ico") {
    // 手机浏览器会自动来要图标；不给的话它会在控制台留一堆 401。
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === "/health") {
    handleHealth(res);
    return;
  }
  if (pathname === "/api/login") {
    // 本机监听器不提供登录：本机走内部 token，本来就不需要口令。
    if (mode !== "lan") {
      safeEndError(res, 404, "Not Found");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      safeEndError(res, 405, "Method Not Allowed");
      return;
    }
    void handleLanLogin(req, res);
    return;
  }
  if (pathname === "/api/logout") {
    if (mode !== "lan") {
      safeEndError(res, 404, "Not Found");
      return;
    }
    handleLanLogout(req, res);
    return;
  }

  // ── ② 鉴权 ────────────────────────────────────────────────────
  // 局域网侧只认登录会话；本机侧沿用原来的进程内部 token。
  if (mode === "lan") {
    const sessionToken = readCookie(req.headers.cookie, LAN_SESSION_COOKIE);
    if (!isLanSessionValid(sessionToken)) {
      // ⚠️ 没带 / 不对 / 过期，一律同一种 401，不给爆破者额外信息。
      safeEndError(res, 401, "Unauthorized");
      return;
    }
  } else if (!isAuthorized(req, searchParams)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return;
  }

  if (req.method === "OPTIONS") {
    setCorsHeaders(res, req.headers.origin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "*");
    res.writeHead(204);
    res.end();
    return;
  }

  // ⚠️ 只读检索 API 必须排在"只允许 GET"之前：识图接口是 POST。
  //    各路由自己的方法检查在 handleLanApi 里。
  setCorsHeaders(res, req.headers.origin);
  if (handleLanApi(req, res, pathname, searchParams)) {
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  // ── ③ 媒体路由（按 path 的传统入口，渲染层在用）─────────────────
  if (MEDIA_ROUTES.has(pathname)) {
    const filePath = searchParams.get("path");
    if (!filePath) {
      res.writeHead(400);
      res.end("Missing 'path' query parameter");
      return;
    }

    const safePath = resolveSafePath(filePath);
    if (!safePath) {
      res.writeHead(403);
      res.end("Forbidden");
      log.warn(`[HttpServer] Security: blocked access to ${filePath}`);
      return;
    }

    switch (pathname) {
      case "/thumbnail":
        handleThumbnail(safePath, res);
        break;
      case "/preview":
        handlePreview(safePath, res);
        break;
      case "/image":
        handleImage(safePath, res, req);
        break;
      default:
        handleDuelPreview(safePath, res);
        break;
    }
    return;
  }

  // 只读白名单之外的一切（含将来可能被误加的写接口）都在这里被拒掉。
  res.writeHead(501);
  res.end("Not Implemented");
}

// ── 端口重试启动逻辑 ──────────────────────────────────────────────────

const MAX_RETRIES = 10;
const DYNAMIC_PORT_RANGE_START = 49_152;
const DYNAMIC_PORT_RANGE_END = 65_535;

function getRandomDynamicPort(): number {
  return (
    Math.floor(
      Math.random() * (DYNAMIC_PORT_RANGE_END - DYNAMIC_PORT_RANGE_START + 1)
    ) + DYNAMIC_PORT_RANGE_START
  );
}

export function startHttpServerEarly(): Promise<number> {
  if (isServerStarted && serverPort !== null) {
    return Promise.resolve(serverPort);
  }

  return new Promise<number>((resolve, reject) => {
    let attempts = 0;

    function tryListen(): void {
      // Prefer OS-assigned port on first attempt, but if we've
      // already run before (e.g. restart after data migration),
      // reuse the last-used port so the renderer's preload-injected
      // --http-port value stays valid.
      const port =
        attempts === 0 ? (lastUsedPort ?? 0) : getRandomDynamicPort();

      server = http.createServer((req, res) =>
        handleRequest(req, res, "internal")
      );

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          attempts++;
          if (attempts < MAX_RETRIES) {
            log.warn(
              `[HttpServer] Port ${port} is occupied, retrying (attempt ${attempts + 1}/${MAX_RETRIES})…`
            );
            server?.close();
            server = null;
            tryListen();
            return;
          }
          reject(
            new Error(
              `[HttpServer] Failed to find an available port after ${MAX_RETRIES} attempts`
            )
          );
          return;
        }
        reject(err);
      });

      server.listen(port, "127.0.0.1", () => {
        const addr = server?.address();
        if (addr && typeof addr === "object") {
          serverPort = addr.port;
          lastUsedPort = addr.port;
          isServerStarted = true;
          console.log(`[HttpServer] Started on http://127.0.0.1:${serverPort}`);
          // 局域网监听器是**另一个**监听器：它起不来不影响本机功能。
          syncLanListener().catch((error: unknown) => {
            log.warn(
              `[LAN] 初始化局域网监听失败：${(error as Error)?.message ?? String(error)}`
            );
          });
          resolve(serverPort);
        } else {
          reject(new Error("[HttpServer] Failed to obtain server address"));
        }
      });
    }

    tryListen();
  });
}

export function stopHttpServer(): Promise<void> {
  // 局域网监听器与它同生共死：数据目录迁移等场景会整体停掉再拉起。
  lanAppliedSignature = "";
  lanListenError = null;
  lanSessions.clear();
  const lanClosed = closeLanListener();

  if (!server) {
    isServerStarted = false;
    serverPort = null;
    return lanClosed;
  }

  return lanClosed.then(
    () =>
      new Promise<void>((resolve) => {
        server?.close(() => {
          console.log(
            `[HttpServer] Stopped (active conversions: ${conversionSemaphore.active}, queued: ${conversionSemaphore.queued})`
          );
          server = null;
          serverPort = null;
          isServerStarted = false;
          resolve();
        });
      })
  );
}

// ── 状态查询 ──────────────────────────────────────────────────────────

export function getHttpServerPort(): number | null {
  return serverPort;
}

export function getHttpServerAuthToken(): string {
  return authToken;
}

export function isHttpServerRunning(): boolean {
  return isServerStarted;
}
