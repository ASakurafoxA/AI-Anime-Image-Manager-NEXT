/**
 * CCIP 角色模型：可用性检测 + 「角色识别特征源」判定（NEXT 版新增）。
 *
 * 用户口径（2026-10）：
 *   · CCIP 和 PixAI 一样是**外置可选模型**（不进安装包，放 `<图库>/models/ccip/`）；
 *   · 软件里**默认首选 CCIP**（开关默认开）；
 *   · 开关开着、但**没放 CCIP 模型** → **角色识别不可用**并明确提示
 *     （不偷偷回退，避免"结果变了却不知道为什么"）；
 *   · 用户**手动关掉开关** = 已知晓 → 回到现有特征（Chinese-CLIP）。
 *
 * 为什么需要这张表之外还要"特征数"判断：模型文件在、但全库特征还没算过时，
 * 角色识别同样无法工作 —— 这种情况要给出**不同的提示**（去算特征，而不是去放模型）。
 */
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "@/services/settings-manager";
import { getCcipVectorCount } from "./ai/vector-db";

/** 模型目录名（相对 `<图库>/models`）。 */
export const CCIP_MODEL_DIR_NAME = "ccip";
/** 特征模型文件名（只需这一个；度量模型的行为已实测等价于余弦，无需带入）。 */
export const CCIP_FEATURE_FILE = "model_feat.onnx";
/** 特征维度（实测 `[1,768]`）。 */
export const CCIP_FEATURE_DIM = 768;

/**
 * 设置键：角色识别是否优先用 CCIP。
 *
 * 存 `app_settings`（与其它自用开关一致）。**缺省视为开启** —— 用户明确要求默认开，
 * 所以只有显式写入 `"false"` 才算关闭。
 */
export const CCIP_PREFER_SETTING_KEY = "ai.characterRecognitionUseCcip";

/** `<图库>/models/ccip` 的绝对路径。 */
export function getCcipModelDir(modelsDir: string): string {
  return path.join(modelsDir, CCIP_MODEL_DIR_NAME);
}

/** CCIP 特征模型的绝对路径。 */
export function getCcipFeatureModelPath(modelsDir: string): string {
  return path.join(getCcipModelDir(modelsDir), CCIP_FEATURE_FILE);
}

/** 模型文件是否就位（只看文件存在，不看特征是否已算）。 */
export function isCcipModelAvailable(modelsDir: string): boolean {
  try {
    const file = getCcipFeatureModelPath(modelsDir);
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** 设置里是否"优先 CCIP"（缺省 true）。 */
export function isCcipPreferred(): boolean {
  try {
    return getSetting(CCIP_PREFER_SETTING_KEY) !== "false";
  } catch {
    return true;
  }
}

export type CharacterFeatureSource = "ccip" | "clip" | "unavailable";

export type CharacterFeatureReason =
  /** 用 CCIP（模型在、特征也有了）*/
  | "ccip-ready"
  /** 用户手动关掉了开关 → 用现有 CLIP 特征 */
  | "prefer-disabled"
  /** 开关开着但模型文件缺失 */
  | "model-missing"
  /** 模型在、但全库 CCIP 特征一条都没有（还没算过）*/
  | "vectors-missing"
  /** 向量库尚未就绪 */
  | "vector-db-not-ready";

export interface CharacterFeatureStatus {
  source: CharacterFeatureSource;
  reason: CharacterFeatureReason;
  /** 设置里是否优先 CCIP */
  preferCcip: boolean;
  /** 模型文件是否就位 */
  modelAvailable: boolean;
  /** 已算好的 CCIP 特征条数 */
  vectorCount: number;
}

/**
 * 判定"角色识别该用哪套特征"。UI 与服务层共用这一个入口，避免两边判断不一致。
 *
 * @param modelsDir `<图库>/models`
 */
export async function resolveCharacterFeatureStatus(
  modelsDir: string
): Promise<CharacterFeatureStatus> {
  const preferCcip = isCcipPreferred();
  const modelAvailable = isCcipModelAvailable(modelsDir);
  let vectorCount = 0;
  try {
    vectorCount = await getCcipVectorCount();
  } catch {
    vectorCount = 0;
  }

  if (!preferCcip) {
    return {
      source: "clip",
      reason: "prefer-disabled",
      preferCcip,
      modelAvailable,
      vectorCount,
    };
  }
  if (!modelAvailable) {
    return {
      source: "unavailable",
      reason: "model-missing",
      preferCcip,
      modelAvailable,
      vectorCount,
    };
  }
  if (vectorCount === 0) {
    return {
      source: "unavailable",
      reason: "vectors-missing",
      preferCcip,
      modelAvailable,
      vectorCount,
    };
  }
  return {
    source: "ccip",
    reason: "ccip-ready",
    preferCcip,
    modelAvailable,
    vectorCount,
  };
}