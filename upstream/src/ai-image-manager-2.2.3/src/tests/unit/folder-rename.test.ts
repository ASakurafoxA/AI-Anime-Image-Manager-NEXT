/**
 * 「在软件里重命名文件夹」的核心逻辑单测。
 *
 * 为什么要专门测：`replacePathPrefix` 一旦写错，改一次文件夹名就会把图库里
 * **成片的路径改坏**（比如把 12 号文件夹的子孙误伤到 123 号里去）✗ ——
 * 这种错误没法靠手点发现，必须靠单测钉住 ✓。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  replacePathPrefix,
  validateFolderName,
} from "@/services/folder-rename";

describe("replacePathPrefix", () => {
  it("文件夹自己：直接换成新路径", () => {
    const oldPrefix = path.join("C:", "库", "12");
    const newPrefix = path.join("C:", "库", "十二");
    expect(replacePathPrefix(oldPrefix, oldPrefix, newPrefix)).toBe(newPrefix);
  });

  it("子文件夹与文件：保留后半段", () => {
    const oldPrefix = path.join("C:", "库", "12");
    const newPrefix = path.join("C:", "库", "十二");
    expect(
      replacePathPrefix(path.join("C:", "库", "12", "a.jpg"), oldPrefix, newPrefix)
    ).toBe(path.join("C:", "库", "十二", "a.jpg"));
    expect(
      replacePathPrefix(
        path.join("C:", "库", "12", "sub", "b.jpg"),
        oldPrefix,
        newPrefix
      )
    ).toBe(path.join("C:", "库", "十二", "sub", "b.jpg"));
  });

  it("必须按目录边界匹配：12 不能误伤 123", () => {
    const oldPrefix = path.join("C:", "库", "12");
    const newPrefix = path.join("C:", "库", "十二");
    // 前缀字符串相同，但 123 是**另一个文件夹** ✗
    expect(
      replacePathPrefix(path.join("C:", "库", "123", "a.jpg"), oldPrefix, newPrefix)
    ).toBeNull();
    expect(
      replacePathPrefix(path.join("C:", "库", "120"), oldPrefix, newPrefix)
    ).toBeNull();
  });

  it("不相关的路径返回 null", () => {
    expect(
      replacePathPrefix(
        path.join("C:", "别的库", "12", "a.jpg"),
        path.join("C:", "库", "12"),
        path.join("C:", "库", "十二")
      )
    ).toBeNull();
  });
});

describe("validateFolderName", () => {
  it("正常名字放行", () => {
    expect(validateFolderName("十二号角色")).toBeNull();
    expect(validateFolderName("  R-18  ")).toBeNull();
  });

  it("空名与 . / .. 一律拦下", () => {
    expect(validateFolderName("")).not.toBeNull();
    expect(validateFolderName("   ")).not.toBeNull();
    expect(validateFolderName(".")).not.toBeNull();
    expect(validateFolderName("..")).not.toBeNull();
  });

  it("非法字符拦下", () => {
    for (const bad of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateFolderName(bad)).not.toBeNull();
    }
  });

  it("结尾是点拦下（Windows 会静默去掉，导致磁盘与图库对不上）", () => {
    expect(validateFolderName("名字.")).not.toBeNull();
  });

  it("结尾空格不用报错 —— 会被自动裁掉后当合法名用", () => {
    expect(validateFolderName("名字 ")).toBeNull();
    expect(validateFolderName("  名字  ")).toBeNull();
  });

  it("Windows 保留名拦下", () => {
    expect(validateFolderName("CON")).not.toBeNull();
    expect(validateFolderName("com1")).not.toBeNull();
    expect(validateFolderName("LPT9.txt")).not.toBeNull();
  });
});
