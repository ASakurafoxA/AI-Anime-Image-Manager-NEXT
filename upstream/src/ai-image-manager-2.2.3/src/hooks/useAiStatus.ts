import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/manager";
import type { AiStatus } from "@/types/photo";

export function useAiStatus() {
  return useQuery<AiStatus>({
    queryKey: ["aiStatus"],
    queryFn: async () => {
      const result = await ipc.client.photos.getAiStatus({});
      return result as AiStatus;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      const phase = data?.embeddingProgress?.phase;
      /*
       * 自用（需求 7）：打标阶段 `isEmbedding` 是 **false**（那个标记只描述特征提取），
       * 所以原来打标时会掉到 30 秒轮询一次 —— 侧边栏的"处理速度 / 预估剩余时间"
       * 就几乎永远算不出来（需要窗口内至少两个样本）。这里把打标/重建索引/加载模型
       * 也一并按 3 秒轮询。
       */
      const busy =
        Boolean(data?.isEmbedding) ||
        phase === "tagging" ||
        phase === "repairing" ||
        phase === "loading";
      return busy ? 1000 : 30_000;
    },
  });
}
