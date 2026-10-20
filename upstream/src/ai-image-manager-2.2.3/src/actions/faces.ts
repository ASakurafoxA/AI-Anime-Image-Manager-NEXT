import { ipc } from "@/ipc/manager";

/**
 * 自用：角色识别相关的渲染层动作集合。
 *
 * ⚠️ 2026-10-18（会话#9）：**SFace 人脸链路已整体剔除**，这里只剩**新模型（CCIP）**那条链 ——
 * 角色 = 标签（`tags` 里「角色」分类下的标签），特征 = `ccip_embeddings`（768 维），
 * 不再有 `face_*` 的任何调用 ✓
 *
 * 名字仍保留 `faceActions`（历史原因）：有 4 个组件按这个名字引用它，
 * 改名会牵一片，收益为零，所以只清内容、不改名。
 */
export const faceActions = {
  /**
   * 找出「未命名的同角色」并写入 AI 建议标签（会跑向量检索，可能耗时几十秒）。
   */
  analyzeUnnamedCharacters: (input?: {
    dryRun?: boolean;
    minPhotos?: number;
    minSimilarity?: number;
  }) => ipc.client.photos.analyzeUnnamedCharacters(input),
  /** 「识别漏标签的已有角色」的分析进度（弹窗里显示走到哪了） */
  getCharacterSuggestProgress: () =>
    ipc.client.photos.getCharacterSuggestProgress({}),
  /** 角色识别的特征源状态（界面据此决定按钮可用性与提示） */
  getCharacterFeatureStatus: () =>
    ipc.client.photos.getCharacterFeatureStatus({}),
  /** 生成全库 CCIP 角色特征（一次性、可能几小时；可取消、可续算） */
  buildCharacterFeatures: (input?: {
    limit?: number;
    workers?: number;
    threadsPerWorker?: number;
  }) => ipc.client.photos.buildCharacterFeatures(input),
  /** 取消正在进行的角色特征生成（已算好的保留） */
  cancelCharacterFeatures: () =>
    ipc.client.photos.cancelCharacterFeatures({}),
  /** 角色特征生成的实时进度（界面轮询用） */
  getCharacterFeatureProgress: () =>
    ipc.client.photos.getCharacterFeatureProgress({}),
  /** 聚类分析的实时进度（界面轮询用） */
  getCharacterClusterProgress: () =>
    ipc.client.photos.getCharacterClusterProgress({}),
  /** 发现「没有角色标签」的角色组（无监督聚类） */
  discoverUnnamedCharacterGroups: (input?: {
    similarityThreshold?: number;
    minGroupSize?: number;
    maxGroupSize?: number;
    limit?: number;
  }) => ipc.client.photos.discoverUnnamedCharacterGroups(input),
  /** 读上次的分组结果（不用重新分析） */
  getStoredCharacterGroups: () =>
    ipc.client.photos.getStoredCharacterGroups({}),
  /** 取一个分组里**全部**照片（展开查看 / 看大图 / 勾选部分图用） */
  getCharacterGroupPhotos: (photoIds: number[]) =>
    ipc.client.photos.getCharacterGroupPhotos({ photoIds }),
  /** 按标签取该角色下的全部照片（"我创建的角色"展开用） */
  listTagPhotos: (tagId: number) => ipc.client.photos.listTagPhotos({ tagId }),
  /** 把勾选的图从角色上撤下来（"退回未命名"，并放回待命名列表） */
  removeTagFromPhotos: (tagId: number, photoIds: number[]) =>
    ipc.client.photos.removeTagFromPhotos({ tagId, photoIds }),
  /** 丢掉分组缓存（想重新分析时用） */
  clearStoredCharacterGroups: () =>
    ipc.client.photos.clearStoredCharacterGroups({}),
  /**
   * **清除未命名的角色检测结果**（已命名的保留）。
   * 用户口径：「清除未命名的结果，要二次确认，已经命名的不能被删」。
   */
  clearUnnamedCharacterResults: () =>
    ipc.client.photos.clearUnnamedCharacterResults({}),
  /** 命名时搜索已有标签（命中就直接用，不再新建） */
  searchCharacterTags: (input: { query: string; limit?: number }) =>
    ipc.client.photos.searchCharacterTags(input),
  /** 人物识别页面用的「我手动创建的角色」列表 */
  listManualCharacterRoles: () =>
    ipc.client.photos.listManualCharacterRoles({}),
  /** 给手动创建的角色改名（标签名一起改） */
  renameManualCharacterRole: (input: { tagId: number; name: string }) =>
    ipc.client.photos.renameManualCharacterRole(input),
  /** 把某张图设为「我创建的角色」的图集封面 */
  setManualRoleCover: (input: {
    tagId: number;
    photoId: number;
    thumbnailPath?: string | null;
  }) => ipc.client.photos.setManualRoleCover(input),
  /** 给一个聚类组命名（写 AI 建议标签，不覆盖已有标签） */
  nameCharacterGroup: (input: {
    name?: string;
    tagId?: number;
    photoIds: number[];
    confidence?: number;
    groupIndex?: number;
  }) => ipc.client.photos.nameCharacterGroup(input),
};
