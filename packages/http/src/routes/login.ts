import Router from "@koa/router";
import logger from "@biliLive-tools/shared/utils/log.js";

import {
  createDouyinSession,
  getDouyinSession,
  cancelDouyinSession,
} from "../services/douyinLogin.js";

/**
 * Web（docker/browser）模式下的平台扫码登录
 * 客户端（Electron）模式走 window.api.cookie.*，不经过此路由
 */

const router = new Router({
  prefix: "/login",
});

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DOUYU_REFERER =
  "https://passport.douyu.com/index/login?passport_reg_callback=PASSPORT_REG_SUCCESS_CALLBACK&passport_login_callback=PASSPORT_LOGIN_SUCCESS_CALLBACK&passport_close_callback=PASSPORT_CLOSE_CALLBACK&passport_dp_callback=PASSPORT_DP_CALLBACK&type=login&client_id=1&state=https%3A%2F%2Fwww.douyu.com%2F&source=click_topnavi_login";

const collectCookies = (res: Response): Record<string, string> => {
  const cookies: Record<string, string> = {};
  const list = (res.headers as any).getSetCookie?.() ?? [];
  for (const line of list) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) {
      cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return cookies;
};

// ---------------------------------------------------------------------------
// 斗鱼
// ---------------------------------------------------------------------------
router.get("/douyu/qrcode", async (ctx) => {
  try {
    const res = await fetch("https://passport.douyu.com/scan/generateCode", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Referer: DOUYU_REFERER,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "client_id=1",
    });
    const data = await res.json();
    if (data.error !== 0 || !data.data?.code) {
      ctx.body = { ok: false, error: data?.message || "获取斗鱼登录二维码失败" };
      return;
    }
    logger.info("[douyu-login] 获取二维码成功");
    ctx.body = {
      ok: true,
      data: {
        id: data.data.code,
        expire: data.data.expire ?? 300,
        // 二维码内容：官方返回的扫码中间页地址
        qrUrl: data.data.url,
      },
    };
  } catch (err: any) {
    logger.error("[douyu-login] 获取二维码失败:", err?.message);
    ctx.body = { ok: false, error: `获取斗鱼登录二维码失败: ${err?.message}` };
  }
});

router.get("/douyu/check", async (ctx) => {
  const code = String(ctx.query.id || "");
  if (!code) {
    ctx.body = { ok: false, error: "缺少参数 id" };
    return;
  }
  try {
    const checkRes = await fetch(
      `https://passport.douyu.com/lapi/passport/qrcode/check?time=${Date.now()}&code=${encodeURIComponent(code)}`,
      { headers: { "User-Agent": UA, Referer: DOUYU_REFERER } },
    );
    const checkCookies = collectCookies(checkRes);
    const data = await checkRes.json();

    if (data.error === -2) {
      // 客户端还未扫码
      ctx.body = { ok: true, data: { status: "waiting" } };
      return;
    }
    if (data.error === 1) {
      // 已扫码，等待手机端确认
      ctx.body = { ok: true, data: { status: "scanned", message: data.data } };
      return;
    }
    if (data.error === -1) {
      ctx.body = { ok: true, data: { status: "cancelled", message: "已取消登录" } };
      return;
    }
    if (data.error !== 0 || !data.data?.url) {
      ctx.body = { ok: true, data: { status: "error", message: data.data || "登录状态异常" } };
      return;
    }

    // 扫码确认成功：请求登录地址换取 cookie
    let loginUrl: string = data.data.url;
    if (loginUrl.startsWith("//")) loginUrl = `https:${loginUrl}`;
    else if (loginUrl.startsWith("/")) loginUrl = `https://passport.douyu.com${loginUrl}`;
    const sep = loginUrl.includes("?") ? "&" : "?";
    const loginRes = await fetch(
      `${loginUrl}${sep}callback=appClient_json_callback&_=${Date.now()}`,
      { headers: { "User-Agent": UA, Referer: DOUYU_REFERER } },
    );
    const loginCookies = collectCookies(loginRes);
    const text = await loginRes.text();

    let payload: any = null;
    const m = text.match(/appClient_json_callback\(([\s\S]*)\)/);
    if (m) {
      try {
        payload = JSON.parse(m[1]);
      } catch {
        payload = null;
      }
    }
    if (payload && payload.error !== 0) {
      ctx.body = { ok: true, data: { status: "error", message: payload.msg || "登录失败" } };
      return;
    }

    const cookies = { ...checkCookies, ...loginCookies };
    const cookieStr = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (!cookieStr) {
      ctx.body = { ok: true, data: { status: "error", message: "未获取到 Cookie，请重试" } };
      return;
    }
    logger.info("[douyu-login] 扫码登录成功");
    ctx.body = { ok: true, data: { status: "completed", cookie: cookieStr } };
  } catch (err: any) {
    logger.error("[douyu-login] 检查登录状态失败:", err?.message);
    ctx.body = { ok: false, error: `检查登录状态失败: ${err?.message}` };
  }
});

// ---------------------------------------------------------------------------
// 抖音（无头 Chromium + CDP）
// ---------------------------------------------------------------------------
router.get("/douyin/qrcode", async (ctx) => {
  try {
    const session = await createDouyinSession();
    ctx.body = {
      ok: true,
      data: {
        id: session.id,
        status: session.status,
        message: session.message,
        qrcode: session.qrcode,
      },
    };
  } catch (err: any) {
    logger.error("[douyin-login] 创建扫码会话失败:", err?.message);
    ctx.body = { ok: false, error: err?.message || "创建抖音扫码会话失败" };
  }
});

router.get("/douyin/check", async (ctx) => {
  const id = String(ctx.query.id || "");
  const session = getDouyinSession(id);
  if (!session) {
    ctx.body = { ok: true, data: { status: "expired", message: "会话不存在或已结束，请重新获取" } };
    return;
  }
  ctx.body = {
    ok: true,
    data: {
      status: session.status,
      message: session.message,
      qrcode: session.qrcode,
      cookie: session.cookie,
    },
  };
});

router.get("/douyin/cancel", async (ctx) => {
  const id = String(ctx.query.id || "");
  await cancelDouyinSession(id);
  ctx.body = { ok: true, data: null };
});

export default router;
