import type {
  Connection as LanceConnection,
  Table as LanceTable,
} from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHINESE_CLIP_V1_ADAPTER_ID,
  SIGLIP_V1_ADAPTER_ID,
  setActiveEmbeddingAdapter,
} from "@/services/ai/model-adapter";
import { getActiveEmbeddingModel } from "@/services/ai/model-config";
import {
  isAiSearchReady,
  searchByText,
  warmupAiSearch,
} from "@/services/ai/search";
import {
  setEmbeddingModel,
  setIsModelLoaded,
  setIsVectorDBReady,
  setPhotoTable,
  setVectordb,
} from "@/services/ai/state";

const CJK_RE = /[一-鿿]/;

vi.mock("@/services/ai/translation-worker-client", () => ({
  getTranslationModelVersion: () => "translation-test-v1",
  translateChineseToEnglish: vi.fn().mockResolvedValue("cute kitten"),
  warmupTranslationWorker: vi.fn().mockResolvedValue(undefined),
}));

function createVectorTable(results: Record<string, unknown>[] = []) {
  const toArray = vi.fn().mockResolvedValue(results);
  const query = {
    distanceType: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    refineFactor: vi.fn().mockReturnThis(),
    // 自用（2026-10-16）：检索路径新增了 nprobes（真实 VectorQuery 本来就有 ✓），
    // 假索引也要补上，否则调用会抛 TypeError ✗ —— 是测试替身缺方法，不是代码问题 ✓
    nprobes: vi.fn().mockReturnThis(),
    toArray,
  };
  return {
    countRows: vi.fn().mockResolvedValue(10),
    query: vi.fn().mockReturnValue(query),
    vectorSearch: vi.fn().mockReturnValue(query),
  } as unknown as LanceTable;
}

function createEmbeddingVector(): number[] {
  return new Array(getActiveEmbeddingModel().vectorDimensions).fill(0.1);
}

function installReadyAi(
  table: ReturnType<typeof createVectorTable>,
  embedTexts: (texts: string[]) => Promise<number[][]>
) {
  setEmbeddingModel({
    embedImage: vi.fn(),
    embedText: async (text) => (await embedTexts([text]))[0],
    embedTexts,
  });
  setIsModelLoaded(true);
  setPhotoTable(table);
  setVectordb({} as unknown as LanceConnection);
  setIsVectorDBReady(true);
}

afterEach(() => {
  setEmbeddingModel(null);
  setIsModelLoaded(false);
  setPhotoTable(null);
  setVectordb(null);
  setIsVectorDBReady(false);
});

/*
 * 自用（2026-10 换中文 CLIP）：这套用例描述的是 **SigLIP** 那条路径的行为
 *（它仍保留作回退路线），而默认活动模型已换成 Chinese-CLIP，
 * 所以这里显式切回 SigLIP；用例结束恢复默认，避免影响别的用例。
 */
beforeEach(() => setActiveEmbeddingAdapter(SIGLIP_V1_ADAPTER_ID));
afterEach(() => setActiveEmbeddingAdapter(CHINESE_CLIP_V1_ADAPTER_ID));

describe("AI semantic search warmup", () => {
  it("预热模型和向量查询后才报告搜索就绪", async () => {
    const table = createVectorTable();
    const embedTexts = vi.fn().mockResolvedValue([createEmbeddingVector()]);
    installReadyAi(table, embedTexts);

    expect(isAiSearchReady()).toBe(false);
    await warmupAiSearch();

    expect(isAiSearchReady()).toBe(true);
    expect(embedTexts).toHaveBeenCalledWith(["a photo"]);
    expect(table.vectorSearch).toHaveBeenCalledOnce();
  });

  it("相同查询并发到达时复用同一个进行中任务", async () => {
    const table = createVectorTable([{ photo_id: 7, _distance: 0.2 }]);
    const embedTexts = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [createEmbeddingVector()];
    });
    installReadyAi(table, embedTexts);

    const first = searchByText("concurrency-cat-test", 5);
    const second = searchByText("concurrency-cat-test", 5);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(embedTexts).toHaveBeenCalledOnce();
    expect(table.vectorSearch).toHaveBeenCalledOnce();
  });

  it("中文多 Prompt 使用一次批量推理并复用行数查询", async () => {
    const table = createVectorTable([{ photo_id: 8, _distance: 0.2 }]);
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => createEmbeddingVector())
    );
    installReadyAi(table, embedTexts);

    await searchByText("可爱猫咪", 20);

    expect(embedTexts).toHaveBeenCalledOnce();
    expect(embedTexts.mock.calls[0][0]).toHaveLength(2);
    expect(
      embedTexts.mock.calls[0][0].every(
        (prompt: string) => !CJK_RE.test(prompt)
      )
    ).toBe(true);
    expect(table.countRows).toHaveBeenCalledOnce();
    expect(table.vectorSearch).toHaveBeenCalledTimes(2);
  });

  /*
   * 自用（2026-10-16，**修"筛选阈值和角标不是一个刻度"**）：
   * 顶栏滑杆的值（IPC `minSimilarity` → `SemanticTextSearchOptions.minSimilarity`）
   * 必须真的走到评分层当硬下限，而不是只躺在 zod schema 里 ✗。
   * 这条用例还顺带盯住**搜索 TTL 缓存键**：键里少了滑杆值的话，
   * 第二次（90%）会直接命中第一次（未设）的缓存 → 仍然返回 80% 的图 ✗。
   */
  it("滑杆下限（minSimilarity）会一路生效到语义阈值上", async () => {
    const table = createVectorTable([{ photo_id: 9, _distance: 0.2 }]);
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => createEmbeddingVector())
    );
    installReadyAi(table, embedTexts);

    const query = "可爱猫咪-similarity-floor";
    const withoutSlider = await searchByText(query, 5);
    const withSlider = await searchByText(query, 5, { minSimilarity: 0.9 });

    // 假索引给的余弦相似度 = 1 - 0.2 = 0.8 → 无滑杆时保留，滑杆 90% 时必须为空 ✓
    expect(withoutSlider.map(({ photoId }) => photoId)).toEqual([9]);
    expect(withSlider).toEqual([]);
  });
});
