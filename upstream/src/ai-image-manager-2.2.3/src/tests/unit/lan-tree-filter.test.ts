import { describe, expect, it, vi } from "vitest";

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
  resolveExcludedFolderIds: vi.fn(),
}));

vi.mock("@/ipc/photos/handlers/listing", () => ({
  queryFolders: mocks.queryFolders,
  queryPhotoById: vi.fn(),
  queryPhotos: vi.fn(),
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

import { listLanFolders } from "@/services/lan-api";

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
