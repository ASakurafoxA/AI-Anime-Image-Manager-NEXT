import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 自用（2026-10-18 · 会话#9）：**清除未命名的角色检测结果**的单测。
 *
 * 用户口径：「清除未命名的结果，要二次确认，**已经命名的不能被删**」。
 * 这是独立重写的一份实现（`services/character-result-cleanup.ts`），
 * 所以单独钉住它的三条底线：
 *   ① 只删 `namedTagId` 为空的分组；
 *   ② 已命名分组、`manualRoles`、文件里其它字段**原样保留**；
 *   ③ 没有可删的东西时**不写文件**（幂等）。
 */
let tempDir = "";

vi.mock("@/utils/data-path", () => ({
  getDataPath: () => tempDir,
}));

import { clearUnnamedCharacterResults } from "@/services/character-result-cleanup";

function storePath(): string {
  return path.join(tempDir, "character-groups.json");
}

function writeStore(payload: unknown): void {
  fs.writeFileSync(storePath(), JSON.stringify(payload), "utf-8");
}

function readStore(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storePath(), "utf-8")) as Record<
    string,
    unknown
  >;
}

function sampleStore() {
  return {
    createdAt: 1_700_000_000_000,
    threshold: 0.85,
    candidates: 2000,
    groups: [
      {
        photoIds: [11, 12, 13],
        size: 3,
        meanSimilarity: 0.9,
        representativeId: 11,
        thumbnails: ["/a.webp"],
        namedTagId: null,
        namedTagName: null,
      },
      {
        photoIds: [21, 22],
        size: 2,
        meanSimilarity: 0.88,
        representativeId: 21,
        thumbnails: ["/b.webp"],
        namedTagId: 777,
        namedTagName: "罗小黑",
      },
      {
        photoIds: [31],
        size: 1,
        meanSimilarity: 0.86,
        representativeId: 31,
        thumbnails: ["/c.webp"],
        namedTagId: null,
        namedTagName: null,
      },
    ],
    manualRoles: [
      {
        tagId: 777,
        tagName: "罗小黑",
        representativePhotoId: 21,
        thumbnailPath: "/b.webp",
        photoCount: 2,
        createdAt: 1_700_000_000_000,
      },
    ],
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-clear-unnamed-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("clearUnnamedCharacterResults", () => {
  it("只删未命名的分组，已命名分组与「我创建的角色」都保留", () => {
    writeStore(sampleStore());

    const result = clearUnnamedCharacterResults();

    expect(result).toMatchObject({
      fileExisted: true,
      removedGroups: 2,
      removedPhotoRefs: 4, // 3 + 1
      keptGroups: 1,
      keptManualRoles: 1,
    });

    const after = readStore();
    const groups = after.groups as Array<{ namedTagId: number | null }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].namedTagId).toBe(777);
    // 其它字段（manualRoles / createdAt / threshold）一个字都没动
    expect(after.manualRoles).toHaveLength(1);
    expect(after.createdAt).toBe(1_700_000_000_000);
    expect(after.threshold).toBe(0.85);
  });

  it("没有可删的分组时不改文件（幂等）", () => {
    writeStore({
      createdAt: 1,
      threshold: 0.85,
      candidates: 10,
      manualRoles: [],
      groups: [
        {
          photoIds: [1],
          size: 1,
          meanSimilarity: 0.9,
          representativeId: 1,
          thumbnails: [],
          namedTagId: 5,
          namedTagName: "已命名",
        },
      ],
    });
    const before = fs.readFileSync(storePath(), "utf-8");

    const result = clearUnnamedCharacterResults();

    expect(result.removedGroups).toBe(0);
    expect(result.keptGroups).toBe(1);
    expect(fs.readFileSync(storePath(), "utf-8")).toBe(before);
  });

  it("文件不存在时什么都不做", () => {
    const result = clearUnnamedCharacterResults();
    expect(result).toMatchObject({
      fileExisted: false,
      removedGroups: 0,
      keptGroups: 0,
    });
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("文件内容不是对象时报错，且不删除任何东西", () => {
    writeStore([1, 2, 3]);
    const before = fs.readFileSync(storePath(), "utf-8");

    expect(() => clearUnnamedCharacterResults()).toThrow();
    expect(fs.readFileSync(storePath(), "utf-8")).toBe(before);
  });
});
