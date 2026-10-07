import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 局域网只读 API 的端到端测试。
 *
 * `lan-api` 被替换成桩：这里验证的是 **HTTP 这一层** ——
 * 鉴权是否天然继承、查询参数有没有解析对、下载/Range 头对不对，
 * 以及最重要的：**响应里漏出磁盘路径时会被拦下来**。
 *
 * 范围（用户明确收窄）：只服务手机端「全部照片」那一屏 ——
 * 列表 + 文件夹树 + 标签树 + 按 id 取图/下载。收藏、以图搜图、详情、任何写操作都不提供。
 */
const lanStub = vi.hoisted(() => ({
  password: "correct-horse",
  port: 0,
  revision: "1",
}));

const apiMocks = vi.hoisted(() => ({
  getLanPhotoFilePath: vi.fn(),
  listLanFolders: vi.fn(),
  listLanPhotos: vi.fn(),
  listLanPhotosByIds: vi.fn(),
  listLanTags: vi.fn(),
}));

/** 识图用到的 AI 侧接口（http-server 里是动态 import，这里整个替换掉）。*/
const aiMocks = vi.hoisted(() => ({
  isAiSearchReady: vi.fn(() => true),
  searchByImage: vi.fn(),
}));

/**
 * ⚠️ `vi.hoisted` 的回调在 import 之前执行，所以这里**不能**碰 fs/os/path，
 * 只能放一个可变占位；真正的临时目录在 `beforeAll` 里创建。
 */
const pathState = vi.hoisted(() => ({ tempRoot: "" }));

vi.mock("@/services/lan-access", () => ({
  getCredentialRevision: () => lanStub.revision,
  getLanConfig: () => ({
    enabled: true,
    hasPermanentPassword: true,
    listeningOnLan: true,
    port: lanStub.port,
    tempPasswordActive: false,
    tempPasswordExpiresAt: null,
    tempPasswordHours: 24,
    tempPasswordSet: false,
  }),
  shouldListenOnLan: () => true,
  tempPasswordRemainingMs: () => 0,
  verifyLanPassword: (candidate: string | null) =>
    candidate === lanStub.password
      ? { kind: "permanent", ok: true }
      : { kind: null, ok: false },
}));

vi.mock("@/services/lan-api", () => apiMocks);

vi.mock("@/services/ai/search", () => aiMocks);

vi.mock("@/utils/data-path", () => ({
  getDataPath: () => pathState.tempRoot,
}));

vi.mock("@/utils/folder-paths", () => ({
  getFolderPaths: () => [],
}));

import {
  startHttpServerEarly,
  stopHttpServer,
  syncLanListener,
} from "@/services/http-server";

interface TestResponse {
  body: string;
  headers: http.IncomingHttpHeaders;
  status: number;
}

function request(
  port: number,
  requestPath: string,
  options: { cookie?: string; headers?: Record<string, string> } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookie) {
      headers.cookie = options.cookie;
    }
    const req = http.request(
      { headers, host: "127.0.0.1", method: "GET", path: requestPath, port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            status: res.statusCode ?? 0,
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function postBinary(
  port: number,
  requestPath: string,
  body: Buffer,
  contentType: string,
  cookie?: string
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-length": String(body.length),
      "content-type": contentType,
    };
    if (cookie) {
      headers.cookie = cookie;
    }
    const req = http.request(
      { headers, host: "127.0.0.1", method: "POST", path: requestPath, port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            status: res.statusCode ?? 0,
          })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("LAN read-only API", () => {
  let lanPort: number;
  let cookie: string;
  let originalFile: string;

  beforeAll(async () => {
    pathState.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aim-lan-api-"));
    originalFile = path.join(pathState.tempRoot, "sample.jpg");
    // 32 字节可预测内容，便于校验 Range 返回的确是那一段
    fs.writeFileSync(originalFile, Buffer.from("0123456789abcdefghijklmnopqrstuv"));

    lanStub.port = await findFreePort();
    lanPort = lanStub.port;
    await startHttpServerEarly();
    await syncLanListener();

    cookie = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({ password: lanStub.password });
      const req = http.request(
        {
          headers: {
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json",
          },
          host: "127.0.0.1",
          method: "POST",
          path: "/api/login",
          port: lanPort,
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            const setCookie = res.headers["set-cookie"]?.[0] ?? "";
            resolve(setCookie.split(";")[0] ?? "");
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  });

  afterAll(async () => {
    await stopHttpServer();
    if (pathState.tempRoot) {
      fs.rmSync(pathState.tempRoot, { force: true, recursive: true });
    }
  });

  it("所有 /api 路由都继承局域网鉴权", async () => {
    for (const route of [
      "/api/photos",
      "/api/folders",
      "/api/tags",
      "/api/search-by-image",
      "/api/photo/1/thumb",
      "/api/photo/1/image",
      "/api/photo/1/download",
    ]) {
      const response = await request(lanPort, route);
      expect(response.status, `${route} 未登录应为 401`).toBe(401);
    }
  });

  it("不存在的接口返回 501，而不是泄漏路由信息", async () => {
    // 收藏 / 以图搜图 / 详情 这些「不给」的功能，服务端根本没有对应路由
    for (const route of [
      "/api/favorites",
      "/api/search?q=x",
      "/api/photo/1",
      "/api/settings",
    ]) {
      const response = await request(lanPort, route, { cookie });
      expect(response.status, `${route} 应当不存在`).toBe(501);
    }
  });

  it("列表接口解析查询参数，并原样返回分页信息", async () => {
    apiMocks.listLanPhotos.mockResolvedValueOnce({
      hasMore: false,
      items: [{ filename: "a.jpg", id: 7, urls: { thumb: "/x" } }],
      limit: 20,
      mode: "list",
      offset: 40,
      total: 61,
    });

    const response = await request(
      lanPort,
      "/api/photos?limit=20&offset=40&sort=name&order=asc&folderId=9&tagId=3&favorite=1&q=abc",
      { cookie }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).total).toBe(61);
    expect(apiMocks.listLanPhotos).toHaveBeenCalledWith(
      expect.objectContaining({
        favoriteOnly: true,
        folderId: 9,
        limit: 20,
        offset: 40,
        order: "asc",
        search: "abc",
        sort: "name",
        tagId: 3,
      })
    );
  });

  it("文件夹树与标签树", async () => {
    apiMocks.listLanFolders.mockReturnValueOnce([
      { id: 1, name: "测试图", parentId: null, photoCount: 75 },
    ]);
    apiMocks.listLanTags.mockReturnValueOnce([
      { id: 5, name: "和服 (kimono)", parentId: null, photoCount: 12 },
    ]);

    const folders = await request(lanPort, "/api/folders", { cookie });
    expect(folders.status).toBe(200);
    expect(JSON.parse(folders.body).items).toEqual([
      { id: 1, name: "测试图", parentId: null, photoCount: 75 },
    ]);

    const tags = await request(lanPort, "/api/tags", { cookie });
    expect(tags.status).toBe(200);
    expect(JSON.parse(tags.body).items).toEqual([
      { id: 5, name: "和服 (kimono)", parentId: null, photoCount: 12 },
    ]);
  });

  it("列表失败时返回 500 而不是空列表", async () => {
    apiMocks.listLanPhotos.mockRejectedValueOnce(new Error("boom"));
    const response = await request(lanPort, "/api/photos", { cookie });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).error).toBe("list_failed");
  });

  it("下载原图：附件头 + 文件名 + 支持 Range 续传", async () => {
    apiMocks.getLanPhotoFilePath.mockReturnValue({
      filename: "中文 名字.jpg",
      path: originalFile,
    });

    const full = await request(lanPort, "/api/photo/3/download", { cookie });
    expect(full.status).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["content-length"]).toBe("32");
    expect(full.headers["content-disposition"]).toContain("attachment");
    // 中文文件名必须走 RFC 5987 的 filename*
    expect(full.headers["content-disposition"]).toContain(
      encodeURIComponent("中文 名字.jpg")
    );
    expect(full.body).toBe("0123456789abcdefghijklmnopqrstuv");

    const ranged = await request(lanPort, "/api/photo/3/download", {
      cookie,
      headers: { range: "bytes=4-7" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-range"]).toBe("bytes 4-7/32");
    expect(ranged.headers["content-length"]).toBe("4");
    expect(ranged.body).toBe("4567");

    const suffix = await request(lanPort, "/api/photo/3/download", {
      cookie,
      headers: { range: "bytes=-3" },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.body).toBe("tuv");
  });

  it("照片不存在时下载返回 404", async () => {
    apiMocks.getLanPhotoFilePath.mockReturnValueOnce(null);
    const response = await request(lanPort, "/api/photo/404/download", {
      cookie,
    });
    expect(response.status).toBe(404);
  });

  it("响应里漏出磁盘路径时会被拦下，绝不发给客户端", async () => {
    apiMocks.listLanPhotos.mockResolvedValueOnce({
      hasMore: false,
      items: [
        {
          // 模拟"字段白名单被写错、把原始行透传出去"的 bug
          filename: "leak.jpg",
          id: 1,
          path: "C:\\Users\\User\\Pictures\\secret\\leak.jpg",
        },
      ],
      limit: 60,
      mode: "list",
      offset: 0,
      total: 1,
    });

    const response = await request(lanPort, "/api/photos", { cookie });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("C:");
    expect(JSON.parse(response.body).error).toBe("internal_error");
  });

  describe("识图 POST /api/search-by-image", () => {
    let capturedPath: string | null = null;

    it("只接受 POST（GET → 405）", async () => {
      const response = await request(lanPort, "/api/search-by-image", {
        cookie,
      });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("POST");
    });

    it("非图片类型 → 415", async () => {
      const response = await postBinary(
        lanPort,
        "/api/search-by-image",
        Buffer.from("definitely not an image"),
        "text/plain",
        cookie
      );
      expect(response.status).toBe(415);
      expect(JSON.parse(response.body).error).toBe("unsupported_media_type");
    });

    it("超过 8MB → 413（且是干净的响应，不是连接重置）", async () => {
      const response = await postBinary(
        lanPort,
        "/api/search-by-image",
        Buffer.alloc(8 * 1024 * 1024 + 1, 7),
        "image/jpeg",
        cookie
      );
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body).maxBytes).toBe(8 * 1024 * 1024);
    });

    it("AI 未就绪 → 503，绝不假装“没找到”", async () => {
      aiMocks.isAiSearchReady.mockReturnValueOnce(false);
      const response = await postBinary(
        lanPort,
        "/api/search-by-image",
        Buffer.from("fake-jpeg"),
        "image/jpeg",
        cookie
      );
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body).error).toBe("ai_not_ready");
    });

    it("正常识图：返回命中列表，且上传的图**立刻从磁盘删掉**", async () => {
      aiMocks.isAiSearchReady.mockReturnValue(true);
      aiMocks.searchByImage.mockImplementationOnce(
        async (filePath: string) => {
          // 搜索时文件必须真的在磁盘上（AI 是从文件读像素的）
          expect(fs.existsSync(filePath)).toBe(true);
          capturedPath = filePath;
          return [{ photoId: 5, similarity: 0.9 }];
        }
      );
      apiMocks.listLanPhotosByIds.mockReturnValueOnce([
        { filename: "hit.jpg", id: 5, urls: { thumb: "/x" } },
      ]);

      const response = await postBinary(
        lanPort,
        "/api/search-by-image",
        Buffer.from("fake-jpeg-bytes"),
        "image/jpeg",
        cookie
      );
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.mode).toBe("image");
      expect(payload.items).toHaveLength(1);
      expect(apiMocks.listLanPhotosByIds).toHaveBeenCalledWith([5], 60);

      // 用后即删（删除是异步的，给它一点时间）
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(capturedPath).not.toBeNull();
      expect(fs.existsSync(capturedPath as unknown as string)).toBe(false);
    });

    it("识图失败 → 500（不静默吞错）", async () => {
      aiMocks.isAiSearchReady.mockReturnValue(true);
      aiMocks.searchByImage.mockRejectedValueOnce(new Error("boom"));
      const response = await postBinary(
        lanPort,
        "/api/search-by-image",
        Buffer.from("fake"),
        "image/jpeg",
        cookie
      );
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body).error).toBe("search_failed");
    });
  });
});
