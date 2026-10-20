import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 每个用例一个独立临时目录，避免互相污染。 */
let tempDir = "";

vi.mock("@/utils/data-path", () => ({
  getDataPath: () => tempDir,
}));

import {
  addManualRole,
  clearCharacterGroups,
  listManualRoles,
  markGroupNamed,
  pruneManualRoles,
  readCharacterGroups,
  removeManualRole,
  removeUnnamedGroups,
  renameManualRole,
  writeCharacterGroups,
  type StoredCharacterGroups,
} from "@/services/character-group-store";

function sample(): StoredCharacterGroups {
  return {
    createdAt: 1_700_000_000_000,
    threshold: 0.85,
    candidates: 2000,
    manualRoles: [],
    groups: [
      {
        photoIds: [1, 2, 3],
        size: 3,
        meanSimilarity: 0.9,
        representativeId: 1,
        thumbnails: ["/a.jpg"],
        namedTagId: null,
        namedTagName: null,
      },
      {
        photoIds: [4, 5],
        size: 2,
        meanSimilarity: 0.88,
        representativeId: 4,
        thumbnails: [],
        namedTagId: null,
        namedTagName: null,
      },
    ],
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-char-groups-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("character-group-store", () => {
  it("没有文件时返回 null（调用方回退到「需要重新分析」）", () => {
    expect(readCharacterGroups()).toBeNull();
  });

  it("写入后能原样读回来", () => {
    writeCharacterGroups(sample());
    const back = readCharacterGroups();
    expect(back?.threshold).toBe(0.85);
    expect(back?.groups).toHaveLength(2);
    expect(back?.groups[0].photoIds).toEqual([1, 2, 3]);
  });

  it("按组序号记住「这组已命名」", () => {
    writeCharacterGroups(sample());
    markGroupNamed(1, null, 42, "铃兰");
    const back = readCharacterGroups();
    expect(back?.groups[0].namedTagId).toBeNull();
    expect(back?.groups[1].namedTagId).toBe(42);
    expect(back?.groups[1].namedTagName).toBe("铃兰");
  });

  it("没有组序号时按代表图匹配（防止界面顺序变了标错）", () => {
    writeCharacterGroups(sample());
    markGroupNamed(null, 4, 7, "测试角色");
    expect(readCharacterGroups()?.groups[1].namedTagId).toBe(7);
  });

  it("文件损坏时返回 null，不抛错", () => {
    fs.writeFileSync(path.join(tempDir, "character-groups.json"), "{不是合法 json", "utf-8");
    expect(readCharacterGroups()).toBeNull();
  });

  it("老格式缺字段时补默认值", () => {
    fs.writeFileSync(
      path.join(tempDir, "character-groups.json"),
      JSON.stringify({ groups: [{ photoIds: [9, 10] }] }),
      "utf-8"
    );
    const back = readCharacterGroups();
    expect(back?.groups[0].size).toBe(2);
    expect(back?.groups[0].representativeId).toBe(9);
    expect(back?.groups[0].namedTagId).toBeNull();
    expect(back?.threshold).toBe(0.85);
  });

  it("清缓存后读不到", () => {
    writeCharacterGroups(sample());
    clearCharacterGroups();
    expect(readCharacterGroups()).toBeNull();
  });
});

describe("手动创建的角色（人物识别页面用）", () => {
  it("记下、列出、改名、移除", () => {
    addManualRole({
      tagId: 100,
      tagName: "铃兰",
      representativePhotoId: 1,
      thumbnailPath: "/a.jpg",
      photoCount: 12,
      createdAt: 1,
    });
    expect(listManualRoles()).toHaveLength(1);
    expect(listManualRoles()[0].tagName).toBe("铃兰");

    renameManualRole(100, "铃兰（新）");
    expect(listManualRoles()[0].tagName).toBe("铃兰（新）");

    removeManualRole(100);
    expect(listManualRoles()).toHaveLength(0);
  });

  it("同一个标签重复创建只保留一条（不重复堆叠）", () => {
    addManualRole({
      tagId: 7,
      tagName: "旧名",
      representativePhotoId: 1,
      thumbnailPath: null,
      photoCount: 3,
      createdAt: 1,
    });
    addManualRole({
      tagId: 7,
      tagName: "新名",
      representativePhotoId: 2,
      thumbnailPath: null,
      photoCount: 5,
      createdAt: 2,
    });
    const roles = listManualRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].tagName).toBe("新名");
    expect(roles[0].photoCount).toBe(5);
  });

  it("自愈：剔掉已经不存在的标签", () => {
    addManualRole({
      tagId: 1,
      tagName: "在的",
      representativePhotoId: 1,
      thumbnailPath: null,
      photoCount: 1,
      createdAt: 1,
    });
    addManualRole({
      tagId: 2,
      tagName: "被删的",
      representativePhotoId: 2,
      thumbnailPath: null,
      photoCount: 1,
      createdAt: 1,
    });
    pruneManualRoles(new Set([1]));
    expect(listManualRoles().map((role) => role.tagId)).toEqual([1]);
  });

  it("没有分组缓存时也能记录角色（自动建空壳）", () => {
    expect(readCharacterGroups()).toBeNull();
    addManualRole({
      tagId: 9,
      tagName: "新角色",
      representativePhotoId: 3,
      thumbnailPath: null,
      photoCount: 4,
      createdAt: 1,
    });
    expect(listManualRoles()).toHaveLength(1);
    expect(readCharacterGroups()?.groups).toEqual([]);
  });

  it("老文件没有 manualRoles 字段时按空列表处理", () => {
    fs.writeFileSync(
      path.join(tempDir, "character-groups.json"),
      JSON.stringify({ groups: [] }),
      "utf-8"
    );
    expect(listManualRoles()).toEqual([]);
  });

  /*
   * 自用（2026-10-17，用户口径）：**只删"还没命名"的检测结果** ✓
   * 「删除全部检测结果」按钮必须保住已命名的分组与「我创建的角色」
   */
  it("删除未命名结果时保留已命名的分组与「我创建的角色」", () => {
    writeCharacterGroups(sample());
    markGroupNamed(0, null, 42, "铃兰"); // 第 1 组已命名
    addManualRole({
      tagId: 42,
      tagName: "铃兰",
      representativePhotoId: 1,
      thumbnailPath: null,
      photoCount: 3,
      createdAt: 1,
    });

    const removed = removeUnnamedGroups();

    expect(removed).toBe(1); // 只有第 2 组是未命名的
    const back = readCharacterGroups();
    expect(back?.groups).toHaveLength(1);
    expect(back?.groups[0].namedTagName).toBe("铃兰");
    // 「我创建的角色」一个都不许丢
    expect(listManualRoles().map((role) => role.tagName)).toEqual(["铃兰"]);
  });

  it("全部都已命名时，删除未命名结果是空操作（removed = 0）", () => {
    writeCharacterGroups(sample());
    markGroupNamed(0, null, 1, "A");
    markGroupNamed(1, null, 2, "B");

    expect(removeUnnamedGroups()).toBe(0);
    expect(readCharacterGroups()?.groups).toHaveLength(2);
  });

  it("没有缓存文件时删除未命名结果不报错", () => {
    expect(removeUnnamedGroups()).toBe(0);
  });
});