import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 局域网访问服务层测试。
 *
 * 用内存 Map 顶掉 `app_settings`，所以**不会碰真实图库数据库**。
 * 重点验证三件事：
 *  1. 口令**只存哈希**，明文绝不落库；
 *  2. 临时口令只按时长失效；
 *  3. `shouldListenOnLan()` / `listeningOnLan` 的三重条件（开关 + 口令 + 端口）。
 */
const store = vi.hoisted(() => new Map<string, string>());

vi.mock("@/services/settings-manager", () => ({
  deleteSetting: (key: string) => {
    store.delete(key);
  },
  getSetting: (key: string) => store.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    store.set(key, value);
  },
}));

import {
  clearPermanentPassword,
  clearTempPassword,
  generatePermanentPassword,
  generateRandomPassword,
  generateTempPassword,
  getCredentialRevision,
  getLanConfig,
  LAN_PERMANENT_HASH_KEY,
  LAN_PERMANENT_SALT_KEY,
  LAN_PORT_KEY,
  LAN_RANDOM_PORT_MAX,
  LAN_RANDOM_PORT_MIN,
  LAN_TEMP_EXPIRES_AT_KEY,
  LAN_TEMP_HASH_KEY,
  MIN_PASSWORD_LENGTH,
  setLanEnabled,
  setLanPort,
  setPermanentPassword,
  setRandomLanPort,
  setTempPassword,
  setTempPasswordHours,
  tempPasswordRemainingMs,
  verifyLanPassword,
} from "@/services/lan-access";

describe("lan access", () => {
  beforeEach(() => {
    store.clear();
  });

  it("默认是关闭的，而且不会监听局域网", () => {
    const view = getLanConfig();
    expect(view.enabled).toBe(false);
    expect(view.hasPermanentPassword).toBe(false);
    expect(view.listeningOnLan).toBe(false);
    expect(view.tempPasswordSet).toBe(false);
    expect(view.tempPasswordActive).toBe(false);
    expect(view.tempPasswordExpiresAt).toBeNull();
    expect(view.tempPasswordHours).toBe(24);
  });

  it("端口是随机分配的（不是写死的数字），会落库且重复读取稳定", () => {
    const view = getLanConfig();
    expect(view.port).toBeGreaterThanOrEqual(LAN_RANDOM_PORT_MIN);
    expect(view.port).toBeLessThanOrEqual(LAN_RANDOM_PORT_MAX);
    expect(store.get(LAN_PORT_KEY)).toBe(String(view.port));
    expect(getLanConfig().port).toBe(view.port);
  });

  it("永久口令只存哈希与盐，明文不落库", () => {
    setPermanentPassword("suzuran_123");

    expect(verifyLanPassword("suzuran_123")).toEqual({
      kind: "permanent",
      ok: true,
    });
    expect(verifyLanPassword("suzuran_124").ok).toBe(false);
    expect(verifyLanPassword(null).ok).toBe(false);
    expect(verifyLanPassword("").ok).toBe(false);

    // scrypt 64 字节 → 128 个十六进制字符；盐 16 字节 → 32 个字符
    expect(store.get(LAN_PERMANENT_HASH_KEY)).toMatch(/^[0-9a-f]{128}$/);
    expect(store.get(LAN_PERMANENT_SALT_KEY)).toMatch(/^[0-9a-f]{32}$/);
    for (const value of store.values()) {
      expect(value).not.toBe("suzuran_123");
    }
  });

  it("同一口令每次设置的盐不同（哈希也不相同）", () => {
    setPermanentPassword("lanpass1");
    const first = store.get(LAN_PERMANENT_HASH_KEY);
    setPermanentPassword("lanpass1");
    expect(store.get(LAN_PERMANENT_HASH_KEY)).not.toBe(first);
    expect(verifyLanPassword("lanpass1").ok).toBe(true);
  });

  it("拒绝过短的口令，边界长度可以通过", () => {
    expect(() =>
      setPermanentPassword("x".repeat(MIN_PASSWORD_LENGTH - 1))
    ).toThrow();
    setPermanentPassword("x".repeat(MIN_PASSWORD_LENGTH));
    expect(verifyLanPassword("x".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it("端口可以手改；非法值被拒绝，库里存坏了会自动换成随机端口", () => {
    setLanPort(5000);
    expect(getLanConfig().port).toBe(5000);

    expect(() => setLanPort(80)).toThrow();
    expect(() => setLanPort(70_000)).toThrow();
    expect(() => setLanPort(Number.NaN)).toThrow();
    // 被拒绝的值不会污染已有配置
    expect(getLanConfig().port).toBe(5000);

    store.set(LAN_PORT_KEY, "not-a-port");
    const healed = getLanConfig().port;
    expect(healed).toBeGreaterThanOrEqual(LAN_RANDOM_PORT_MIN);
    expect(healed).toBeLessThanOrEqual(LAN_RANDOM_PORT_MAX);

    const random = setRandomLanPort();
    expect(random).toBeGreaterThanOrEqual(LAN_RANDOM_PORT_MIN);
    expect(random).toBeLessThanOrEqual(LAN_RANDOM_PORT_MAX);
    expect(getLanConfig().port).toBe(random);
  });

  it("必须同时满足「开关 + 永久口令」才会监听局域网", () => {
    setLanEnabled(true);
    expect(getLanConfig().listeningOnLan).toBe(false);

    setPermanentPassword("lanpass1");
    expect(getLanConfig().listeningOnLan).toBe(true);

    setLanEnabled(false);
    expect(getLanConfig().listeningOnLan).toBe(false);
  });

  it("随机临时口令可用，且明文不落库", () => {
    const { password, expiresAt } = generateTempPassword(3);

    expect(password).toHaveLength(10);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(verifyLanPassword(password)).toEqual({ kind: "temp", ok: true });

    const view = getLanConfig();
    expect(view.tempPasswordSet).toBe(true);
    expect(view.tempPasswordActive).toBe(true);
    expect(view.tempPasswordHours).toBe(3);
    expect(tempPasswordRemainingMs()).toBeGreaterThan(0);
    for (const value of store.values()) {
      expect(value).not.toBe(password);
    }
  });

  it("临时口令过期后失效，但仍记录为已设置", () => {
    const { password } = generateTempPassword(1);
    store.set(LAN_TEMP_EXPIRES_AT_KEY, String(Date.now() - 1000));

    expect(verifyLanPassword(password).ok).toBe(false);
    const view = getLanConfig();
    expect(view.tempPasswordSet).toBe(true);
    expect(view.tempPasswordActive).toBe(false);
    expect(tempPasswordRemainingMs()).toBe(0);
  });

  it("清除临时口令后旧口令立即失效", () => {
    const { password } = generateTempPassword(24);
    expect(verifyLanPassword(password).ok).toBe(true);

    clearTempPassword();
    expect(verifyLanPassword(password).ok).toBe(false);
    expect(store.has(LAN_TEMP_HASH_KEY)).toBe(false);
    expect(getLanConfig().tempPasswordSet).toBe(false);
  });

  it("支持自定义临时口令，改时长会从当前时刻重新起算", () => {
    const before = setTempPassword("guest123", 1);
    expect(verifyLanPassword("guest123")).toEqual({
      kind: "temp",
      ok: true,
    });

    setTempPasswordHours(24);
    const after = getLanConfig().tempPasswordExpiresAt;
    expect(after).not.toBeNull();
    expect(after as number).toBeGreaterThan(before + 60_000);
    expect(verifyLanPassword("guest123").ok).toBe(true);
  });

  it("永久口令的清除会同时撤销口令与监听条件", () => {
    setLanEnabled(true);
    setPermanentPassword("lanpass1");
    expect(getLanConfig().listeningOnLan).toBe(true);

    clearPermanentPassword();
    expect(getLanConfig().hasPermanentPassword).toBe(false);
    expect(getLanConfig().listeningOnLan).toBe(false);
  });

  it("随机口令不含易混字符", () => {
    for (let index = 0; index < 20; index++) {
      const password = generateRandomPassword(12);
      expect(password).toHaveLength(12);
      expect(password).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]+$/);
    }
  });

  it("随机生成的永久口令可以直接登录", () => {
    const password = generatePermanentPassword();
    expect(password).toHaveLength(12);
    expect(verifyLanPassword(password)).toEqual({
      kind: "permanent",
      ok: true,
    });
  });

  it("口令变更会递增版本号（阶段 2 用它让旧会话失效）", () => {
    expect(getCredentialRevision()).toBe("0");

    setPermanentPassword("lanpass1");
    expect(getCredentialRevision()).toBe("1");

    generatePermanentPassword();
    expect(getCredentialRevision()).toBe("2");

    clearPermanentPassword();
    expect(getCredentialRevision()).toBe("3");

    generateTempPassword(1);
    expect(getCredentialRevision()).toBe("4");
  });
});
