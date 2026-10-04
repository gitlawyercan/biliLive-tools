import axios from "axios";

import { DOUYIN_UA } from "./douyin_headers.js";

/**
 * 官方 ttwid 注册接口（2026-10 实测验证可用）：
 *   POST https://ttwid.bytedance.com/ttwid/union/register/
 *   服务端直接签发 ttwid，Max-Age = 365 天，无需浏览器指纹。
 * 相比旧链路（抓首页 __ac_nonce → 本地算 __ac_signature → 换 ttwid），
 * 拿到的是"服务端签发的真 token"，降低被识别为程序生成 cookie 的概率。
 *
 * 实测结论（verify.ts）：
 *   - aid=6383（抖音直播）/ aid=1768（抖音web）均可签发；
 *   - 用官方 ttwid 调 webcast/room/web/enter 直接 status_code=0；
 *   - 该接口当前甚至不强制 a_bogus，ttwid cookie 是硬性要求。
 */

/** ttwid 池容量：注册成本≈0，多 token 轮换可防单 token 被打标 */
const TTWID_POOL_SIZE = 3;

interface TtwidEntry {
  cookie: string; // "ttwid=xxx"
  /** 该条目的随机有效期（12~36h 抖动），到期后重新注册轮换 */
  expiresAt: number;
  lastUsedAt: number;
  useCount: number;
}

interface RegisterResult {
  cookie: string;
  maxAgeDays: number | null;
}

export const registerTtwid = async (aid = 6383): Promise<RegisterResult> => {
  const res = await axios.post<{
    data: { ttwid?: string } | string;
    message?: string;
  }>(
    "https://ttwid.bytedance.com/ttwid/union/register/",
    {
      region: "cn",
      aid, // 6383=抖音直播, 1768=抖音web
      needFid: false,
      service: "www.ixigua.com",
      migrate_info: { ticket: "", source: "node" },
      cbUrlProtocol: "https",
      union: true,
    },
    {
      timeout: 10e3,
      proxy: false,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": DOUYIN_UA,
      },
    },
  );

  const setCookies = (res.headers["set-cookie"] ?? []) as string[];
  const raw = setCookies.find((c) => c.startsWith("ttwid="));
  if (!raw) {
    throw new Error(`ttwid register: no ttwid in response, body ${JSON.stringify(res.data).slice(0, 120)}`);
  }
  const maxAge = raw.match(/Max-Age=(\d+)/)?.[1];
  return {
    cookie: raw.split(";")[0],
    maxAgeDays: maxAge ? Math.round(Number(maxAge) / 86400) : null,
  };
};

const pool: TtwidEntry[] = [];

/** 单个条目的随机寿命：12~36 小时（防单 token 长期被打标，365 天有效期只是上限） */
const randomLifetimeMs = () => (12 + Math.random() * 24) * 60 * 60 * 1000;

/** 注册并加入池中；返回 null 表示注册失败 */
const acquireNewTtwid = async (): Promise<TtwidEntry | null> => {
  try {
    const { cookie } = await registerTtwid(6383);
    const entry: TtwidEntry = {
      cookie,
      expiresAt: Date.now() + randomLifetimeMs(),
      lastUsedAt: 0,
      useCount: 0,
    };
    pool.push(entry);
    // 池满则淘汰最久未用的
    if (pool.length > TTWID_POOL_SIZE) {
      pool.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      pool.splice(0, pool.length - TTWID_POOL_SIZE);
    }
    return entry;
  } catch (error) {
    console.warn("[DouYin][ttwidPool] 官方 ttwid 注册失败:", error instanceof Error ? error.message : error);
    return null;
  }
};

/** 清理过期条目 */
const purgeExpired = () => {
  const now = Date.now();
  for (let i = pool.length - 1; i >= 0; i--) {
    if (now >= pool[i].expiresAt) {
      pool.splice(i, 1);
    }
  }
};

/**
 * 从池中取一个 ttwid cookie（最近最少使用策略），池空/全部过期时先尝试注册；
 * 注册失败抛错，由调用方决定是否回退旧链路。
 */
export const getPooledTtwidCookie = async (): Promise<string> => {
  purgeExpired();
  let entry = pool.length > 0 ? pool.reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b)) : null;
  if (entry == null) {
    entry = await acquireNewTtwid();
    if (entry == null) {
      throw new Error("ttwid pool: register failed");
    }
  }
  entry.lastUsedAt = Date.now();
  entry.useCount++;
  return entry.cookie;
};

/**
 * 后台补充池子（fire-and-forget，不阻塞请求）；
 * 供调用方在取到 ttwid 之后异步调用，保证池中始终有 2~3 个可用 token。
 */
export const refillTtwidPoolInBackground = (): void => {
  purgeExpired();
  const deficit = TTWID_POOL_SIZE - pool.length;
  for (let i = 0; i < deficit; i++) {
    void acquireNewTtwid();
  }
};

/** 当前池状态（调试用） */
export const getTtwidPoolStatus = () =>
  pool.map((e) => ({
    useCount: e.useCount,
    expiresAt: new Date(e.expiresAt).toISOString(),
  }));
