import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 文件夹树的服务端映射规则。
 *
 * 用户 2026-10 明确要求：黑名单（隐藏）文件夹在手机端**不要消失**，而是
 * **单独放一个位置**（手机端渲染成「已隐藏」一段），这样用户仍能主动点进去看 ——
 * 与桌面侧边栏一致（桌面也是列出来的，只是它们的照片不进聚合视图）。
 *
 * 但有一点不能破：**磁盘路径绝不出现在返回值里**。
 */
const mocks = vi.hoisted(() => ({
  queryFolders: vi.fn(),
  queryPhotos: vi.fn(),
  resolveExcludedFolderIds: vi.fn(),
}));

vi.mock("@/ipc/photos/handlers/listing", () => ({
  queryFolders: mocks.queryFolders,
  queryPhotoById: vi.fn(),
  queryPhotos: mocks.queryPhotos,
}));

vi.mock("@/services/folder-exclusions", () => ({
  resolveExcludedFolderIds: mocks.resolveExcludedFolderIds,
}));

vi.mock("@/services/tag-exclusions", () => ({
  expandHiddenTagIds: vi.fn(() => new Set<number>()),
}));

vi.mock("@/services/ai/search", () => ({
  isAiSearchReady: () => false,
  searchByText: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => {
    throw new Error("这个测试不该碰数据库");
  },
}));

import { listLanFolders, listLanPhotos } from "@/services/lan-api";

function folderRow(over: Record<string, unknown>) {
  return {
    displayName: "x",
    id: 1,
    parentId: null,
    path: "F:\\pics\\x",
    totalPhotoCount: 0,
    ...over,
  };
}

/** `queryPhotos()` 返回行里局域网侧真正用得到的字段（`folderId` 只用于过滤）。*/
function photoRow(over: Record<string, unknown>) {
  return {
    fileDate: 1_700_000_000_000,
    filename: "x.jpg",
    folderId: 1,
    height: 10,
    id: 1,
    width: 10,
    ...over,
  };
}

describe("LAN 文件夹树映射", () => {
  it("隐藏文件夹照常返回，只是打上 hidden 标记；且只带显示名不带路径", () => {
    mocks.queryFolders.mockReturnValueOnce([
      folderRow({
        displayName: "测试图",
        id: 1,
        path: "F:\\pics\\测试图",
        totalPhotoCount: 75,
      }),
      folderRow({
        displayName: "NSFW",
        id: 2,
        parentId: 1,
        path: "F:\\pics\\测试图\\NSFW",
        totalPhotoCount: 85,
      }),
      folderRow({
        displayName: "sub",
        id: 3,
        parentId: 2,
        path: "F:\\pics\\测试图\\NSFW\\sub",
        totalPhotoCount: 4,
      }),
    ]);
    // 桌面用的同一套解析：黑名单 + 其全部子孙
    mocks.resolveExcludedFolderIds.mockReturnValueOnce([2, 3]);

    const items = listLanFolders();

    // 三个都在（不再被剔掉），层级关系保持
    expect(items.map((item) => item.name).sort()).toEqual([
      "NSFW",
      "sub",
      "测试图",
    ]);
    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.get("测试图")?.hidden).toBe(false);
    expect(byName.get("NSFW")?.hidden).toBe(true);
    expect(byName.get("sub")?.hidden).toBe(true);
    expect(byName.get("NSFW")?.parentId).toBe(1);

    // 字段白名单：只有这几个键，绝不带 path
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        "hidden",
        "id",
        "name",
        "parentId",
        "photoCount",
      ]);
    }
    expect(JSON.stringify(items)).not.toContain("F:");
    expect(JSON.stringify(items)).not.toContain("pics");
  });

  it("隐藏文件夹即使没有照片也要发（否则用户看不出这里被隐藏了）", () => {
    mocks.queryFolders.mockReturnValueOnce([
      folderRow({ displayName: "空目录", id: 1, totalPhotoCount: 0 }),
      folderRow({ displayName: "空的隐藏目录", id: 2, totalPhotoCount: 0 }),
    ]);
    mocks.resolveExcludedFolderIds.mockReturnValueOnce([2]);

    const items = listLanFolders();
    expect(items.map((item) => item.name)).toEqual(["空的隐藏目录"]);
    expect(items[0]?.hidden).toBe(true);
  });

  it("父节点被过滤掉时，子节点挂到最近的存活祖先（客户端不用处理悬挂）", () => {
    mocks.queryFolders.mockReturnValueOnce([
      folderRow({ displayName: "顶", id: 1, parentId: null, totalPhotoCount: 10 }),
      folderRow({ displayName: "中间", id: 2, parentId: 1, totalPhotoCount: 0 }),
      folderRow({ displayName: "底", id: 3, parentId: 2, totalPhotoCount: 5 }),
    ]);
    // 中间那层没有照片 → 被过滤（不是黑名单，只是空）
    mocks.resolveExcludedFolderIds.mockReturnValueOnce([]);

    const items = listLanFolders();
    const leaf = items.filter((item) => item.id === 3)[0];
    expect(leaf.parentId).toBe(1);
    expect(leaf.hidden).toBe(false);
  });
});

/**
 * 手机端那个「隐藏文件夹」开关（`excludeHiddenFolders`，与桌面端同名同义）。
 *
 * 用户 2026-10 要求："客户端里的这个显示隐藏文件的功能，web 端没有做对应的功能，也做一下"。
 * 开关只影响**返回照片**的接口；文件夹树不受影响（隐藏文件夹照常返回并带 `hidden` 标记，
 * 手机端把它们渲染到单独的「已隐藏」一段里）。
 *
 * ⚠️ 这里 `queryPhotos()` 是桩，所以验证的是**局域网侧自己做的事**：
 *    ① 出口过滤（语义搜索等绕过 SQL 的路径靠它）
 *    ② 开关原样传给 `queryPhotos()`（SQL 那一层负责 total 与分页）
 *    SQL 里"排除隐藏文件夹及其子孙"本身由桌面既有代码负责，不在这里重复验证。
 */
describe("LAN 照片列表的隐藏文件夹开关", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("开关为真：隐藏文件夹（含子孙）里的照片不出现在列表结果里", async () => {
    mocks.queryPhotos.mockReturnValueOnce({
      items: [
        photoRow({ filename: "正常.jpg", folderId: 1, id: 1 }),
        photoRow({ filename: "隐藏.jpg", folderId: 2, id: 2 }),
        // 黑名单文件夹的**子孙**同样要排除
        photoRow({ filename: "隐藏子孙.jpg", folderId: 3, id: 3 }),
        // 没有 folderId 的孤儿照片照常保留（桌面 queryPhotos 也是这个口径）
        photoRow({ filename: "孤儿.jpg", folderId: null, id: 4 }),
      ],
      limit: 60,
      offset: 0,
      total: 4,
    });
    // 桌面用的同一套解析：黑名单 + 其全部子孙
    mocks.resolveExcludedFolderIds.mockReturnValueOnce([2, 3]);

    const result = await listLanPhotos({ excludeHiddenFolders: true });

    expect(result.items.map((item) => item.filename)).toEqual([
      "正常.jpg",
      "孤儿.jpg",
    ]);
    // 照片结构里**只发**这几个键（`folderId` 只用于过滤，不许漏给手机端）
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual([
        "fileDate",
        "filename",
        "height",
        "id",
        "urls",
        "width",
      ]);
    }
    expect(mocks.resolveExcludedFolderIds).toHaveBeenCalled();
    // 分页与 total 由 SQL 那一层负责，所以开关必须原样传下去
    expect(mocks.queryPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ excludeHiddenFolders: true })
    );
  });

  it("开关关闭或缺省：隐藏文件夹里的照片照旧出现，文件夹树也照常带 hidden 标记", async () => {
    mocks.queryPhotos.mockReturnValue({
      items: [
        photoRow({ filename: "正常.jpg", folderId: 1, id: 1 }),
        photoRow({ filename: "隐藏.jpg", folderId: 2, id: 2 }),
      ],
      limit: 60,
      offset: 0,
      total: 2,
    });
    // 关掉开关时**不解析**黑名单（等于完全不过滤）
    mocks.resolveExcludedFolderIds.mockReturnValue([]);

    const off = await listLanPhotos({ excludeHiddenFolders: false });
    const absent = await listLanPhotos({});

    expect(off.items.map((item) => item.filename)).toEqual([
      "正常.jpg",
      "隐藏.jpg",
    ]);
    // 老客户端不带这个参数 —— 行为必须与改动前一模一样
    expect(absent.items.map((item) => item.filename)).toEqual([
      "正常.jpg",
      "隐藏.jpg",
    ]);
    expect(mocks.queryPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({ excludeHiddenFolders: false })
    );
    expect(mocks.resolveExcludedFolderIds).not.toHaveBeenCalled();

    // 开关只管"照片列表"，文件夹树不受影响：隐藏文件夹照常返回 + 打 hidden 标记
    mocks.queryFolders.mockReturnValueOnce([
      folderRow({ displayName: "正常", id: 1, totalPhotoCount: 3 }),
      folderRow({ displayName: "隐藏", id: 2, totalPhotoCount: 2 }),
    ]);
    mocks.resolveExcludedFolderIds.mockReturnValueOnce([2]);
    const folders = listLanFolders();
    expect(folders.map((folder) => [folder.name, folder.hidden])).toEqual([
      ["正常", false],
      ["隐藏", true],
    ]);
  });
});
