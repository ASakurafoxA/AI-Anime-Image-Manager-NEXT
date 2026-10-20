/**
 * 探针：CCIP 特征抽取的「每卡 worker 数」阶梯实测（**只读图库，不写任何库**）。
 *
 * 为什么需要：设置里「每卡 worker 数（角色识别）」的默认值**不能凭感觉**定 ✗。
 * 2026-10-17 用这个脚本测出：单卡 1/2/3/4 是 ×1 / ×1.5 / ×1.9 / ×2.2，**4 之后饱和**，
 * 所以默认值定为 4（详见 `services/ai/ccip-worker-config.ts` 的注释与 `改动记录.md`）。
 *
 * 用法（在 ai-image-manager-2.2.3 目录下，**应用最好先关掉**，避免抢显卡/磁盘）：
 *   node scripts/probe-ccip-workers.mjs --models="<图库>\models" \
 *        --list="%TEMP%\aim_ccip_paths.json" --workers=1,2,3,4,6 --measure=72 --rounds=2
 *
 * 参数：
 *   --models=<dir>    含 `ccip/model_feat.onnx` 的模型目录（默认 <本机图库>/models）
 *   --list=<json>     样本清单 `[{id, path}]`（默认 %TEMP%/aim_ccip_paths.json）
 *   --workers=a,b,c   要测的"每卡 worker 数"档位（默认 1,2,3,4,6）
 *   --device=<n>      DirectML 设备号（默认 2；用 `--device` 探不到会自动报错）
 *   --threads=<n>     每个 worker 的 intra-op 线程（默认 1，与生产一致）
 *   --measure=<n>     每档固定测多少张（默认 72；**每档测同一批**，否则数字不可比 ✗）
 *   --warm=<n>        每个 worker 先热身几张（默认 4，不计时）
 *   --rounds=<n>      每档跑几轮取平均（默认 2）
 *
 * 口径与生产 worker 完全一致：fork `scripts/ccip-embed-worker.mjs`，
 * `provider=dml` + 指定 deviceId、每 worker 1 线程、批量 8 张。
 * 结果按"张/秒"打印，并给出相对"每卡 1 个"的百分比。
 */
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const modelsDir = arg("models", path.join("F:\\AI Anime Image Manager NEXT", "models"));
const listPath = arg("list", path.join(process.env.TEMP ?? ".", "aim_ccip_paths.json"));
const deviceId = Number.parseInt(arg("device", "2"), 10);
const threads = Number.parseInt(arg("threads", "1"), 10) || 1;
const measure = Number.parseInt(arg("measure", "72"), 10) || 72;
const warmCount = Number.parseInt(arg("warm", "4"), 10) || 0;
const rounds = Math.max(1, Number.parseInt(arg("rounds", "2"), 10) || 1);
const workerScript = path.resolve("scripts/ccip-embed-worker.mjs");

function fail(message) {
  console.error(`[probe-ccip-workers] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(modelsDir, "ccip", "model_feat.onnx"))) {
  fail(`没找到 CCIP 模型：${path.join(modelsDir, "ccip", "model_feat.onnx")}`);
}
if (!fs.existsSync(listPath)) {
  fail(`没找到样本清单：${listPath}（格式 [{id, path}]）`);
}
if (!fs.existsSync(workerScript)) {
  fail(`没找到 worker：${workerScript}`);
}

const raw = JSON.parse(fs.readFileSync(listPath, "utf8"));
const pool = raw.filter((it) => it && typeof it.path === "string" && fs.existsSync(it.path));
if (pool.length < measure) {
  fail(`样本不足：需要 ${measure} 张可用图片，实际 ${pool.length} 张`);
}
/** 每档都测**同一批**（否则不同档之间的数字不可比 ✗） */
const samples = pool.slice(0, measure).map((it) => ({ id: it.id, path: it.path }));

function spawnWorker() {
  const child = fork(workerScript, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  // worker 的 stderr 平时只是 onnxruntime 的告警，屏蔽掉免得刷屏
  child.stderr.on("data", () => {});
  return child;
}

function waitFor(child, type, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
    const onMessage = (message) => {
      if (message?.type === type) {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(message);
      } else if (message?.type === "init-error") {
        clearTimeout(timer);
        child.off("message", onMessage);
        reject(new Error(message.error));
      }
    };
    child.on("message", onMessage);
  });
}

async function embed(child, photos) {
  child.send({ type: "embed", photos });
  return waitFor(child, "result");
}

async function runOne(workerCount) {
  const workers = Array.from({ length: workerCount }, () => spawnWorker());
  try {
    await Promise.all(
      workers.map(async (worker) => {
        worker.send({
          type: "init",
          modelsDir,
          threads,
          provider: "dml",
          deviceId,
        });
        const ready = await waitFor(worker, "ready");
        if (!String(ready.provider ?? "").startsWith("dml")) {
          throw new Error(`没跑在显卡上（provider=${ready.provider}）`);
        }
      })
    );
    // 热身（不计时）
    await Promise.all(
      workers.map(async (worker, index) => {
        if (warmCount === 0) {
          return;
        }
        const warm = Array.from(
          { length: warmCount },
          (_, i) => samples[(index * 11 + i) % samples.length]
        );
        await embed(worker, warm);
      })
    );
    // 正式测量：同一批样本按轮转分给各 worker
    const chunks = Array.from({ length: workerCount }, () => []);
    samples.forEach((item, index) => chunks[index % workerCount].push(item));
    const startedAt = Date.now();
    await Promise.all(
      workers.map(async (worker, index) => {
        const list = chunks[index];
        for (let offset = 0; offset < list.length; offset += 8) {
          await embed(worker, list.slice(offset, offset + 8));
        }
      })
    );
    const seconds = (Date.now() - startedAt) / 1000;
    return samples.length / seconds;
  } finally {
    for (const worker of workers) {
      try {
        worker.send({ type: "shutdown" });
      } catch {
        /* 已经退出 */
      }
    }
  }
}

const ladder = (arg("workers", "1,2,3,4,6") ?? "1,2,3,4,6")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);

console.log(
  `\n[probe-ccip-workers] 模型=${modelsDir} 设备=${deviceId} 线程=${threads} 每档 ${measure} 张 × ${rounds} 轮\n`
);

const results = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const workerCount of ladder) {
    try {
      const rate = await runOne(workerCount);
      results.push({ workerCount, rate });
      console.log(
        `  第 ${round} 轮  每卡 ${workerCount} 个 → ${rate.toFixed(2)} 张/秒`
      );
    } catch (error) {
      console.log(
        `  第 ${round} 轮  每卡 ${workerCount} 个 → 失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
}

const baselineRates = results.filter((item) => item.workerCount === 1);
const baseline =
  baselineRates.reduce((sum, item) => sum + item.rate, 0) /
  Math.max(1, baselineRates.length);

console.log("\n=== 汇总（每档取平均；相对「每卡 1 个」）===");
for (const workerCount of [...new Set(results.map((item) => item.workerCount))].sort((a, b) => a - b)) {
  const rates = results.filter((item) => item.workerCount === workerCount);
  const average = rates.reduce((sum, item) => sum + item.rate, 0) / rates.length;
  const percent = baseline > 0 ? `${Math.round((average / baseline) * 100)}%` : "-";
  console.log(
    `  每卡 ${workerCount} 个：${average.toFixed(2)} 张/秒（${percent}）  明细 [${rates
      .map((item) => item.rate.toFixed(2))
      .join(", ")}]`
  );
}
console.log("");
