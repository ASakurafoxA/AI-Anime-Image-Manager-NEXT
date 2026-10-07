/**
 * PixAI Tagger v1.0 的标签大类划分（自用新增，NEXT 版）。
 *
 * ── 为什么是"6 大类做顶级、`通用` 组内部再沿用旧 13 细类" ────────────────
 * 分类信息来源在这份文件里**被分成两半**，各有各的理由：
 *
 *  1. **六个大类来自模型自己**（`config.json` 的 `tags_split`，见
 *     `scripts/pixai-tagger-worker.mjs` 的 `loadVocab()`）。它是**可靠**的：
 *     区间 `[["general",15043],["character",8308],["copyright",2460],
 *     ["style",4917],["meta",145],["rating",4]]` 合计 30,877 = `tags` 的长度，
 *     标签名就是按这个顺序摊平的，worker 逐标签带出 `category` 字符串
 *     （⚠️ 与 WD14 的**数字** category 不同）与 `categoryIndex`（0–5）。
 *     所以这里**不要再自己猜** —— 大类归属用 worker 返回值即可。
 *
 *  2. **`通用`（general）内部的 13 细类模型不给**。它就是自用版当初为 WD14
 *     现写的关键词/正则表（`wd14-tag-categories.ts`，覆盖率的量化验证见
 *     `_research/measure_tag_categories.cjs`），而它正是用户已经习惯的浏览方式。
 *     重写一套没有收益、只有回归风险，所以**原样复用** `categorizeWd14Tag()`。
 *
 * ── "老标签原地不动" ────────────────────────────────────────────────
 * `通用` 与 `角色` 两个**父标签名沿用现有库里的旧名字**（WD14 客户端就是把
 * `general` → `通用`、`character` → `角色` 落库的），于是换模型后这两组下的
 * 标签树是**原地不动**的：老用户收藏的树结构、以及库里已有的
 * `parentTag = 通用` 映射都不需要迁移。
 * 另外四个（`作品系列` / `画风` / `元信息` / `分级`）是**新维度**
 * ——WD14 要么完全没有（copyright / style），要么被 worker 直接丢弃（rating）。
 *
 * ⚠️ 后四个名字刻意**不同于** WD14 那 13 细类里的
 * `元信息与画质` / `画风与媒介`：那 13 个是 `通用` **内部**的二级目录，
 * 这 4 个是**顶层大类**，两者同名会在侧边栏里看起来是同一个节点。
 */

import {
  WD14_TAG_CATEGORIES,
  categorizeWd14Tag,
} from "./wd14-tag-categories";

/** PixAI 的六个大类（顺序 = 模型 `tags_split` 的顺序，与 `categoryIndex` 一一对应）。 */
export type PixaiCategoryName =
  | "general"
  | "character"
  | "copyright"
  | "style"
  | "meta"
  | "rating";

export interface PixaiCategory {
  /** 模型 `tags_split` 里的分类名（也是 worker 回传的 `tags[].category`） */
  name: PixaiCategoryName;
  /** 侧边栏显示的顶级父标签名 */
  label: string;
  /**
   * 是否再分二级目录。
   * 只有 `general` 为 true（用现有 13 细类）；其余四类**直接挂顶级父标签**，
   * 因为它们的量级不需要再折一层：
   *   character 8,308 / copyright 2,460 / style 4,917 / meta 145 / rating 4
   * （rating 只有 4 个，折目录纯属添乱）。
   */
  subCategorized: boolean;
  /** 判定阈值（来自 `config.json.category_best_threshold`，见 `PIXAI_THRESHOLDS`） */
  threshold: number;
}

/**
 * 标签的父标签名（顶级目录）。
 *
 * `通用` / `角色` 是**复用现有父标签名**：库里已经存在
 * `parentTag = 通用` / `parentTag = 角色` 的映射，改名等于让老标签全部失联。
 * 其余四个是新名字（见文件头注释里"刻意区分"那一段）。
 */
const PIXAI_CATEGORY_LABELS = {
  general: "通用",
  character: "角色",
  copyright: "作品系列",
  style: "画风",
  meta: "元信息",
  rating: "分级",
} as const satisfies Record<PixaiCategoryName, string>;

/**
 * 六分类判定阈值。
 *
 * 值**来自模型自带的 `config.json.category_best_threshold`，不要手改**：
 * worker 在**不**收到 `thresholds` 时也用同一套默认值（`pixai-tagger-worker.mjs`
 * 的 `DEFAULT_THRESHOLDS`），改这里会造成"客户端以为的阈值 ≠ 实际生效的阈值"。
 *
 * 差异很大是有道理的：`style` 0.15 松（模型的画风 logits 普遍偏低），
 * `rating` 0.41 严（分级错判比漏判更烦人）。
 */
export const PIXAI_THRESHOLDS: Record<PixaiCategoryName, number> = {
  general: 0.17,
  character: 0.27,
  copyright: 0.24,
  style: 0.15,
  meta: 0.17,
  rating: 0.41,
};

/**
 * 大类顺序 = 模型 `tags_split` 的顺序。
 * 用它而不是 `Object.keys(PIXAI_CATEGORIES)`：拓扑顺序必须与
 * worker 回传的 `categoryIndex`（0–5）严格对应，不能靠对象字面量顺序碰运气。
 */
export const PIXAI_CATEGORY_ORDER: readonly PixaiCategoryName[] = Object.freeze([
  "general",
  "character",
  "copyright",
  "style",
  "meta",
  "rating",
] as const);

/**
 * 六个大类的完整描述表（供标签树构建 / 诊断面板使用）。
 *
 * ⚠️ 顺序即 `PIXAI_CATEGORY_ORDER`，`name` 与索引一一对应。
 */
export const PIXAI_CATEGORIES: readonly PixaiCategory[] = Object.freeze(
  PIXAI_CATEGORY_ORDER.map(
    (name): PixaiCategory => ({
      name,
      label: PIXAI_CATEGORY_LABELS[name],
      // 只有 general 折二级目录（沿用 13 细类），其余 4 类直接挂父标签
      subCategorized: name === "general",
      threshold: PIXAI_THRESHOLDS[name],
    })
  )
);

/** 校验任意值是否为合法大类名（IPC / 库数据的入口处用）。 */
export function isPixaiCategoryName(
  value: unknown
): value is PixaiCategoryName {
  return (
    typeof value === "string" &&
    (PIXAI_CATEGORY_ORDER as readonly string[]).includes(value)
  );
}

/** 顶级父标签名（`general` → `"通用"`）。 */
export function pixaiParentLabel(name: PixaiCategoryName): string {
  return PIXAI_CATEGORY_LABELS[name];
}

/** 13 细类的 id → 显示名（用现有表，不重复维护）。 */
const WD14_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  WD14_TAG_CATEGORIES.map((category) => [category.id, category.label])
);

/**
 * 取标签在**二级目录**里的显示名。
 *
 * - 只有 `general` 有二级目录：调 `categorizeWd14Tag(name, 0)` 拿 13 细类 id，
 *   再映射到 `WD14_TAG_CATEGORIES` 的 `label`（如 `"hair"` → `"头发"`）。
 *   传 category=0 是刻意的：进到这个分支的标签本来就都是 general 的。
 * - 其余五个大类**一律返回 `null`**（调用方据此把标签直接挂在顶级父标签下）。
 *
 * ⚠️ 兜底：`categorizeWd14Tag` 对 `category=4` / `9` 会返回 `"character"` / `"rating"`，
 * 而这两个 id **不在** `WD14_TAG_CATEGORIES` 里（那是给大类用的）。真出现这种
 * 返回值说明传错了 category，落成"其他"比落成 `undefined`（父标签名变 `"undefined"`）好。
 */
export function pixaiSubCategoryLabel(
  tagName: string,
  name: PixaiCategoryName
): string | null {
  if (name !== "general") {
    return null;
  }
  const id = categorizeWd14Tag(tagName, 0);
  return WD14_CATEGORY_LABELS[id] ?? "其他";
}
