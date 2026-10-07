import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 局域网鉴权的端到端测试。
 *
 * 真的起两个监听器、真的发 HTTP 请求，验证：
 *  1. 局域网监听器绑在 0.0.0.0:<设置端口> 上，未登录拿不到任何媒体；
 *  2. 口令对了才发会话 Cookie，之后媒体请求才放行；
 *  3. **改口令（版本号变化）会让所有旧会话立即失效**；
 *  4. 本机监听器完全不受影响：仍然只认进程内部 token，且**不提供**登录接口；
 *  5. 连续登录失败会被限流。
 *
 * `lan-access` 被整体替换成内存桩，所以**不碰真实数据库**，也不跑 scrypt。
 */
const lanStub = vi.hoisted(() => ({
  permanentPassword: "correct-horse",
  port: 0,
  revision: "1",
}));

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
    candidate === lanStub.permanentPassword
      ? { kind: "permanent", ok: true }
      : { kind: null, ok: false },
}));

// 媒体路由的路径白名单依赖 electron-store（在测试环境里不可用），
// 这些测试只关心"鉴权是否放行"，所以把它换成固定的桩。
vi.mock("@/utils/data-path", () => ({
  getDataPath: () => "/aim-test-data",
}));

vi.mock("@/utils/folder-paths", () => ({
  getFolderPaths: () => [],
}));

import {
  getHttpServerAuthToken,
  getLanListenerStatus,
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
  options: {
    body?: string;
    cookie?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookie) {
      headers.cookie = options.cookie;
    }
    if (options.body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const req = http.request(
      {
        headers,
        host: "127.0.0.1",
        method: options.method ?? "GET",
        path: requestPath,
        port,
      },
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
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/** 会话 Cookie 的头值（`aim_lan_session=...`）。*/
function sessionCookie(response: TestResponse): string {
  const setCookie = response.headers["set-cookie"]?.[0] ?? "";
  return setCookie.split(";")[0] ?? "";
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

describe("LAN HTTP auth", () => {
  let internalPort: number;
  let lanPort: number;

  beforeAll(async () => {
    lanStub.port = await findFreePort();
    lanPort = lanStub.port;
    internalPort = await startHttpServerEarly();
    await syncLanListener();
  });

  afterAll(async () => {
    await stopHttpServer();
  });

  it("局域网监听器绑在设置里的端口上", () => {
    const status = getLanListenerStatus();
    expect(status.active).toBe(true);
    expect(status.port).toBe(lanPort);
    expect(status.error).toBeNull();
  });

  it("/health 不需要口令，且一个字的配置都不泄漏", async () => {
    const response = await request(lanPort, "/health");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    // 只有 ok 一个字段：端口、开关、版本号都不许出现
    expect(Object.keys(JSON.parse(response.body))).toEqual(["ok"]);
  });

  it("未登录访问媒体一律 401", async () => {
    const response = await request(lanPort, "/thumbnail?path=%2Fanywhere.jpg");
    expect(response.status).toBe(401);
  });

  it("口令错误返回 401，且不区分原因", async () => {
    const response = await request(lanPort, "/api/login", {
      body: JSON.stringify({ password: "wrong-password" }),
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("口令正确才发会话 Cookie，之后媒体请求不再是 401", async () => {
    const login = await request(lanPort, "/api/login", {
      body: JSON.stringify({ password: lanStub.permanentPassword }),
      method: "POST",
    });
    expect(login.status).toBe(200);
    expect(JSON.parse(login.body)).toEqual({ ok: true });
    const cookie = sessionCookie(login);
    expect(cookie.startsWith("aim_lan_session=")).toBe(true);
    expect(login.headers["set-cookie"]?.[0]).toContain("HttpOnly");

    const media = await request(lanPort, "/thumbnail?path=%2Fanywhere.jpg", {
      cookie,
    });
    // 具体是 403/404 取决于路径白名单与文件是否存在 —— 关键是**过了鉴权**
    expect(media.status).not.toBe(401);
  });

  it("改口令后旧会话立即失效（口令版本号变了）", async () => {
    const login = await request(lanPort, "/api/login", {
      body: JSON.stringify({ password: lanStub.permanentPassword }),
      method: "POST",
    });
    const cookie = sessionCookie(login);
    expect(
      (await request(lanPort, "/thumbnail?path=%2Fx.jpg", { cookie })).status
    ).not.toBe(401);

    // 模拟"用户在设置页改了口令"：只改版本号，会话表不用动
    lanStub.revision = "2";
    expect(
      (await request(lanPort, "/thumbnail?path=%2Fx.jpg", { cookie })).status
    ).toBe(401);

    lanStub.revision = "1";
  });

  it("登出后会话立刻失效", async () => {
    const login = await request(lanPort, "/api/login", {
      body: JSON.stringify({ password: lanStub.permanentPassword }),
      method: "POST",
    });
    const cookie = sessionCookie(login);
    const logout = await request(lanPort, "/api/logout", {
      cookie,
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect(
      (await request(lanPort, "/thumbnail?path=%2Fx.jpg", { cookie })).status
    ).toBe(401);
  });

  it("登录接口只接受 POST", async () => {
    const response = await request(lanPort, "/api/login");
    expect(response.status).toBe(405);
  });

  it("本机监听器不提供登录接口", async () => {
    const response = await request(internalPort, "/api/login", {
      body: JSON.stringify({ password: lanStub.permanentPassword }),
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  it("本机监听器仍然要求进程内部 token", async () => {
    const response = await request(internalPort, "/image?path=%2Foutside.jpg");
    expect(response.status).toBe(401);

    const withToken = await request(
      internalPort,
      `/image?token=${encodeURIComponent(getHttpServerAuthToken())}&path=%2Foutside.jpg`
    );
    expect(withToken.status).not.toBe(401);
  });

  it("连续登录失败会被限流（429）", async () => {
    let last = 0;
    let sawRateLimit = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await request(lanPort, "/api/login", {
        body: JSON.stringify({ password: `bad-${attempt}` }),
        method: "POST",
      });
      last = response.status;
      if (response.status === 429) {
        sawRateLimit = true;
        expect(response.headers["retry-after"]).toBeDefined();
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
    expect(last).toBe(429);
  });
});
