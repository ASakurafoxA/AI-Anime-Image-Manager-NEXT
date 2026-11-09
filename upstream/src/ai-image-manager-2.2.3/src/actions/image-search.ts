import { ipc } from "@/ipc/manager";

export const imageSearchActions = {
  getPreview: (imagePath: string) =>
    ipc.client.photos.getImageSearchPreview({ imagePath }),
  search: (
    imagePath: string,
    limit = 500,
    /* 自用（2026-11-08 · 会话#11）：semanticOnly = 跳过指纹，只跑语义（「继续搜索相似图像」用） */
    options?: { semanticOnly?: boolean }
  ) => ipc.client.photos.searchByImage({ imagePath, limit, ...options }),
};
