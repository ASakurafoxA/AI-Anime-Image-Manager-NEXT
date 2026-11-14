/**
 * 角色特征中心（质心）的**磁盘缓存**（2026-11-14 · 会话#12）。
 *
 * 为什么需要：补漏每次都要把「已命名照片」的特征读出来算质心 —— 本机 19,458 张 × 768 维，
 * 冷启动/内存紧张时要几十秒（用户实测打包版"读取"一段就三十秒级）。
 * 但质心本身只有 768 个数字 × 几百个角色（约 2~3 MB），完全可以存盘复用。
 *
 * 失效判据（任何一个对不上就重算）：
 *   · CCIP 特征表行数变了（重算过全库特征）
 *   · 角色标签关联数 / 最大关联 id 变了（命名、补漏打标、摘标签都会动它）
 */
import fs from "node:fs";
import path from "node:path";
import { getDataPath } from "@/utils/data-path";

export interface CentroidSumRow {
  /** 每个角色标签一条：sum 是 768 维向量之和（未归一化），count 是样本数 */
  count: number;
  sum: number[];
  tagId: number;
  tagName: string;
}

export interface CentroidStoreFile {
  ccipRows: number;
  linkCount: number;
  maxLinkId: number;
  rows: CentroidSumRow[];
  version: 1;
}

const FILE_NAME = "character-centroids.json";

export function centroidStorePath(): string {
  return path.join(getDataPath(), FILE_NAME);
}

export function readCentroidStore(): CentroidStoreFile | null {
  try {
    const p = centroidStorePath();
    if (!fs.existsSync(p)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as CentroidStoreFile;
    if (raw?.version !== 1 || !Array.isArray(raw.rows)) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeCentroidStore(file: CentroidStoreFile): void {
  try {
    const p = centroidStorePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file), "utf8");
    fs.renameSync(tmp, p);
  } catch {
    /* 存盘失败不影响功能，下次重算即可 */
  }
}
