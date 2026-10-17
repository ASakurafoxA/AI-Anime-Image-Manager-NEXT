/**
 * GPU capability probe worker.
 *
 * Lightweight one-shot worker that probes DirectML GPU availability.
 * Uses the bundled YuNet ONNX model via onnxruntime-node to test whether the
 * DML execution provider works.
 *
 * IPC Protocol:
 *   Parent → { type: "probe", modelsDir: "..." }
 *   Worker → { type: "result", dmlAvailable, gpuName?, gpuIndex?, dmlDeviceId?, error?, probeTimeMs }
 *   Worker exits with code 0.
 *
 * Timeout is enforced by the parent — this worker has no self-timeout.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// ── GPU name detection (best-effort, no extra dependencies) ──────────

const VIRTUAL_GPU_PATTERNS = [
  /virtual/i,
  /mumu/i,
  /oray/i,
  /remote\s*display/i,
  /basic\s*display/i,
  /hyper-?v/i,
  /vmware/i,
  /virtualbox/i,
  /citrix/i,
  /parsec/i,
  /software/i,
  /indirect\s*display/i,
];

/**
 * 独立显卡的命名特征。
 *
 * ⚠️ 故意**不**写宽泛的 `/radeon/i` 或 `/vega/i`：AMD 核显（APU）也叫
 * "AMD Radeon(TM) Graphics"，写宽了会把核显当独显。
 */
const DISCRETE_GPU_PATTERNS = [
  /nvidia/i,
  /geforce/i,
  /\brtx\b/i,
  /\bgtx\b/i,
  /quadro/i,
  /\btitan\b/i,
  /radeon\s+(rx|pro\s+w|vii)/i,
  /intel\s+arc/i,
  /\barc\s+[ab]\d/i,
];

const LINE_BREAK_RE = /\r?\n/u;
const GPU_QUERY_TIMEOUT_MS = 15_000;

export function isRealGpu(name) {
  return !VIRTUAL_GPU_PATTERNS.some((p) => p.test(name));
}

export function isDiscreteGpu(name) {
  return DISCRETE_GPU_PATTERNS.some((p) => p.test(name));
}

/**
 * 从适配器名列表里挑一块要用的显卡，返回 { name, index }（index = 在该列表中的序号）。
 *
 * 双显卡笔记本上 Win32_VideoController 常把核显排在前面，"取第一个真实显卡"
 * 就会挑中核显（用户反馈的 bug：界面显示 Intel 核显、DirectML 也落在核显上）。
 * 所以这里**先找独立显卡**，找不到才退回第一个真实显卡。
 *
 * 返回的 index 可直接当 DirectML 的 `deviceId` 使用（见 handleProbe）。
 */
export function selectRealGpu(names) {
  const real = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (isRealGpu(name)) {
      real.push({ index, name });
    }
  }
  if (real.length === 0) {
    return null;
  }
  return real.find((candidate) => isDiscreteGpu(candidate.name)) || real[0];
}

/** 兼容旧调用：只要名字。 */
export function selectRealGpuName(names) {
  return selectRealGpu(names)?.name ?? null;
}

function parseWmicGpuNames(raw) {
  return raw
    .trim()
    .split(LINE_BREAK_RE)
    .map((line) => line.split(",")[1]?.trim())
    .filter((name) => name && name !== "Name");
}

function parsePowerShellGpuNames(raw) {
  return raw
    .trim()
    .split(LINE_BREAK_RE)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 查询本机显卡名列表（原始顺序，含虚拟适配器）。
 *
 * ⚠️ 顺序是**先 PowerShell**：wmic 自 Windows 11 24H2（Build 26100）起改为
 * "按需功能"、默认不再预装（实测 Build 26100 上 `wmic` 已不存在），
 * 旧版把它当首选只会白等一次超时。wmic 仅作旧系统兜底。
 * 超时放宽到 15 s：PowerShell + CIM 查询冷启动实测约 4.6 s，原来 5 s 太紧。
 */
export function getGpuList() {
  try {
    const raw = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
      ],
      { timeout: GPU_QUERY_TIMEOUT_MS, encoding: "utf-8" }
    );
    const names = parsePowerShellGpuNames(raw);
    // 只在拿到"真实"显卡时才采用本结果；全是虚拟适配器时退回 wmic。
    if (names.some((name) => isRealGpu(name))) {
      return names;
    }
  } catch {
    /* fall through to wmic */
  }

  // 旧系统兜底：wmic（Win11 24H2+ 可能已不存在）
  try {
    const raw = execFileSync(
      "wmic",
      ["path", "Win32_VideoController", "get", "name", "/format:csv"],
      { timeout: GPU_QUERY_TIMEOUT_MS, encoding: "utf-8" }
    );
    return parseWmicGpuNames(raw);
  } catch {
    /* fall through */
  }

  return [];
}

/** 查列表并挑一块，返回 { name, index }；没有"真实"显卡时返回 null。 */
export function getGpuSelection() {
  return selectRealGpu(getGpuList());
}

export function getGpuName() {
  return getGpuSelection()?.name ?? null;
}

// ── onnxruntime-node lazy-load (same pattern as face-worker / embed-worker) ──

let _ort = null;
function loadOrt() {
  if (_ort) {
    return _ort;
  }
  const require = createRequire(import.meta.url);
  try {
    _ort = require("onnxruntime-node");
  } catch {
    // Fallback: packaged builds may alias node_modules elsewhere.
    const projectRoot = path.resolve(import.meta.dirname, "..");
    _ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return _ort;
}

// ── Probe handler ────────────────────────────────────────────────────

async function handleProbe(modelsDir) {
  const probeStart = Date.now();

  // Probe with the active YuNet detector.
  const yunetModel = path.join(
    modelsDir,
    "face",
    "face_detection_yunet_2023mar.onnx"
  );
  const faceModel = yunetModel;

  if (!fs.existsSync(faceModel)) {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: `Model not found: ${faceModel}`,
      probeTimeMs: Date.now() - probeStart,
    });
    process.exit(0);
    return;
  }

  const names = getGpuList();
  const selection = selectRealGpu(names);

  const createSession = async (executionProviders) => {
    const { InferenceSession } = await loadOrt();
    // DML-only session — if this throws, DML is unavailable (JS-catchable).
    return InferenceSession.create(faceModel, {
      executionProviders,
      logSeverityLevel: 3,
    });
  };

  /** 试一块适配器：能建会话就算可用（序号对不上/驱动不支持会抛错）。 */
  const probeAdapter = async (deviceId) => {
    const startedAt = Date.now();
    const name = names[deviceId] ?? null;
    // 虚拟显示适配器（向日葵 / UU 远程 / IDD）也能建 DML 会话，但对用户没意义，
    // 打上标记让界面把它从下拉框里过滤掉。
    const virtual = name ? !isRealGpu(name) : false;
    try {
      const session = await createSession([{ name: "dml", deviceId }]);
      try {
        await session.release?.();
      } catch {
        /* best-effort */
      }
      return {
        deviceId,
        name,
        ok: true,
        probeTimeMs: Date.now() - startedAt,
        virtual,
      };
    } catch (err) {
      return {
        deviceId,
        name,
        ok: false,
        error: err.message || String(err),
        probeTimeMs: Date.now() - startedAt,
        virtual,
      };
    }
  };

  try {
    // 逐块试。Win32 列表里通常还夹着虚拟显示适配器（向日葵 / UU 远程 / IDD），
    // 所以"序号"要一个个验证能不能真的建起 DirectML 会话，界面才能给出可信的下拉列表。
    const adapters = [];
    const limit = Math.min(Math.max(names.length, 1), 6);
    for (let deviceId = 0; deviceId < limit; deviceId++) {
      adapters.push(await probeAdapter(deviceId));
    }

    const usable = adapters.filter((a) => a.ok);
    // 优先用"挑中的那块"（独显）；它不可用就退到第一个可用适配器；都没有则用系统默认。
    let dmlDeviceId = null;
    if (selection && usable.some((a) => a.deviceId === selection.index)) {
      dmlDeviceId = selection.index;
    } else if (usable.length > 0) {
      dmlDeviceId = usable[0].deviceId;
    }

    if (usable.length === 0) {
      // 一个序号都不行：用系统默认适配器再试一次（等价于不带 deviceId）。
      const fallback = await createSession(["dml"]);
      try {
        await fallback.release?.();
      } catch {
        /* best-effort */
      }
    }

    process.send?.({
      type: "result",
      adapters,
      dmlAvailable: true,
      dmlDeviceId,
      gpuIndex: selection?.index ?? null,
      gpuName: selection?.name || "DirectML Compatible GPU",
      probeTimeMs: Date.now() - probeStart,
    });
  } catch (err) {
    process.send?.({
      type: "result",
      adapters: [],
      dmlAvailable: false,
      dmlDeviceId: null,
      error: err.message || String(err),
      gpuIndex: selection?.index ?? null,
      probeTimeMs: Date.now() - probeStart,
    });
  }

  process.exit(0);
}

// ── Message loop ─────────────────────────────────────────────────────

process.on("message", (msg) => {
  if (msg?.type === "probe") {
    handleProbe(msg.modelsDir);
  }
});
