/**
 * 自用（2026-11-09 · 会话#11）：Pixiv 分P（差分）判定 —— 回归用例。
 *
 * 背景（用户口径）：「很多是 Pixiv 分P保存，导致识别出来的其实是差分」，
 * 但「完全相同那边情况不一样（同一张图作者发了两次、或同一张图存在不同路径），需要人工看」，
 * 所以这个筛除**只作用于「视觉相似」**。
 */
import { describe, expect, it } from "vitest";
import { isPixivPageVariant, pixivWorkPage } from "@/utils/pixiv-variants";

describe("pixiv-variants", () => {
  it("解析作品号与页号", () => {
    expect(pixivWorkPage("115115528_p0.jpg")).toEqual({
      page: 0,
      work: "115115528",
    });
    expect(pixivWorkPage("115115528_p12_master1200.png")).toEqual({
      page: 12,
      work: "115115528",
    });
    expect(pixivWorkPage("twitter-12345.jpg")).toBeNull();
    expect(pixivWorkPage(undefined)).toBeNull();
  });

  it("视觉相似 + 同作品不同页 → 判为差分", () => {
    expect(
      isPixivPageVariant({
        matchType: "similar",
        photoCount: 3,
        previewPhotos: [
          { filename: "115115528_p0.jpg" },
          { filename: "115115528_p1.jpg" },
          { filename: "115115528_p2.jpg" },
        ],
      })
    ).toBe(true);
  });

  it("完全相同那一类**不筛**（用户要求人工看）", () => {
    expect(
      isPixivPageVariant({
        matchType: "exact",
        photoCount: 2,
        previewPhotos: [
          { filename: "114415911_p1.png" },
          { filename: "117059030_p5.png" },
        ],
      })
    ).toBe(false);
  });

  it("同作品同一页、或作品号不同 → 不算差分", () => {
    expect(
      isPixivPageVariant({
        matchType: "similar",
        photoCount: 2,
        previewPhotos: [
          { filename: "115115528_p0.jpg" },
          { filename: "115115528_p0.png" },
        ],
      })
    ).toBe(false);
    expect(
      isPixivPageVariant({
        matchType: "similar",
        photoCount: 2,
        previewPhotos: [
          { filename: "115115528_p0.jpg" },
          { filename: "115116647_p0.jpg" },
        ],
      })
    ).toBe(false);
  });

  it("有文件名不符合 Pixiv 命名 → 不筛（退回原行为）", () => {
    expect(
      isPixivPageVariant({
        matchType: "similar",
        photoCount: 2,
        previewPhotos: [
          { filename: "115115528_p0.jpg" },
          { filename: "QQ图片20250213231419.jpg" },
        ],
      })
    ).toBe(false);
  });
});
