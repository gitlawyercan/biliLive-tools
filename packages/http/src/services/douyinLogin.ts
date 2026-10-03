import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";
import logger from "@biliLive-tools/shared/utils/log.js";

/**
 * 抖音网页端扫码登录（CDP 驱动本机 Chromium）
 *
 * 抖音 SSO 接口（sso.douyin.com/get_qrcode 等）存在 TLS 指纹级风控，纯 HTTP 服务端
 * 无法直接调用。此处通过 CDP 控制无头 Chromium 打开官方登录页，监听页面自身的
 * get_qrcode / check_qrconnect 响应来完成扫码流程，浏览器环境真实，稳定性最好。
 */

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH || "",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
];

const findChromium = (): string | null => {
  for (const p of CHROMIUM_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
};

const DOUYIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DOUYIN_LOGIN_URL =
  "https://sso.douyin.com/login/?service=https%3A%2F%2Fwww.douyin.com&next=https%3A%2F%2Fwww.douyin.com%2F";

export type DouyinLoginStatus =
  | "starting"
  | "waiting"
  | "scanned"
  | "completed"
  | "expired"
  | "error";

interface DouyinSession {
  id: string;
  status: DouyinLoginStatus;
  message: string;
  qrcode?: string;
  cookie?: string;
  createdAt: number;
  cleanup: () => Promise<void>;
}

const sessions = new Map<string, DouyinSession>();

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
  sessionId?: string;
}

class CdpBrowser {
  ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId?: string;
  private child?: ReturnType<typeof spawn>;
  private userDataDir?: string;
  onQrCode?: (data: { qrcode?: string; token?: string }) => void;
  onCheck?: (data: { status: number; redirect_url?: string }) => void;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on("message", (raw) => this.handleMessage(String(raw)));
    this.ws.on("error", (err) => logger.error("[douyin-login] ws error:", err.message));
  }

  static async launch(): Promise<CdpBrowser> {
    const chromiumPath = findChromium();
    if (!chromiumPath) {
      throw new Error(
        "未找到 Chromium，网页端扫码登录抖音需要容器内安装 chromium（或通过环境变量 CHROMIUM_PATH 指定路径）",
      );
    }
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bililive-douyin-"));
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--mute-audio",
      "--no-first-run",
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ];
    const child = spawn(chromiumPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("启动 Chromium 超时")), 20000);
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium 启动失败，退出码 ${code}`));
      });
    });

    const browser = new CdpBrowser(new WebSocket(wsUrl));
    browser.child = child;
    browser.userDataDir = userDataDir;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 Chromium 调试端口超时")), 10000);
      browser.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      browser.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return browser;
  }

  private handleMessage(raw: string) {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP 调用失败"));
      else resolve(msg.result);
      return;
    }
    if (msg.method && msg.sessionId === this.sessionId) {
      void this.handleEvent(msg);
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.msgId;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, 30000);
    });
  }

  private async handleEvent(msg: CdpMessage) {
    try {
      if (msg.method === "Network.responseReceived") {
        const url: string = msg.params?.response?.url ?? "";
        const requestId = msg.params?.requestId;
        if (url.includes("/get_qrcode")) {
          const body = await this.getResponseBody(requestId);
          if (body?.data?.qrcode && this.onQrCode) {
            this.onQrCode({ qrcode: body.data.qrcode, token: body.data.token });
          }
        } else if (url.includes("/check_qrconnect")) {
          const body = await this.getResponseBody(requestId);
          if (body?.data && this.onCheck) {
            this.onCheck({ status: body.data.status, redirect_url: body.data.redirect_url });
          }
        }
      } else if (msg.method === "Page.loadEventFired") {
        // 延迟点击「二维码」登录选项卡（若默认不是二维码登录）
        setTimeout(() => void this.clickQrcodeTab(), 1000);
        setTimeout(() => void this.clickQrcodeTab(), 3000);
      }
    } catch (err: any) {
      logger.warn("[douyin-login] 处理页面事件失败:", err?.message);
    }
  }

  private async getResponseBody(requestId: string): Promise<any> {
    const result = await this.send("Network.getResponseBody", { requestId }, this.sessionId);
    if (!result?.body) return null;
    if (result.base64Encoded) {
      return JSON.parse(Buffer.from(result.body, "base64").toString("utf-8"));
    }
    return JSON.parse(result.body);
  }

  private async clickQrcodeTab() {
    if (this.ws.readyState !== WebSocket.OPEN || !this.sessionId) return;
    await this.evaluate(`(() => {
      const els = Array.from(document.querySelectorAll("div,span,a,li"));
      const el = els.find((e) => e.children.length === 0 && /二维码/.test(e.textContent || ""));
      if (el) { el.click(); return true; }
      return false;
    })()`);
  }

  async openLoginPage(url: string) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send("Page.enable", {}, sessionId);
    await this.send("Network.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Emulation.setUserAgentOverride", { userAgent: DOUYIN_UA }, sessionId);
    await this.send("Page.navigate", { url }, sessionId);
  }

  async evaluate(expression: string): Promise<any> {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    );
    return result?.result?.value;
  }

  async getCookies(): Promise<{ name: string; value: string }[]> {
    const result = await this.send(
      "Network.getCookies",
      { urls: ["https://www.douyin.com", "https://sso.douyin.com"] },
      this.sessionId,
    );
    return result?.cookies ?? [];
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.child?.kill();
    if (this.userDataDir) {
      fs.rm(this.userDataDir, { recursive: true, force: true }, () => {});
    }
  }
}

const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/** 创建一个抖音扫码登录会话 */
export async function createDouyinSession(): Promise<DouyinSession> {
  // 清理过期会话
  for (const [id, s] of sessions) {
    if (Date.now() - s.createdAt > 5 * 60 * 1000) {
      sessions.delete(id);
      await s.cleanup();
    }
  }

  const session: DouyinSession = {
    id: genId(),
    status: "starting",
    message: "正在启动浏览器，请稍候",
    createdAt: Date.now(),
    cleanup: async () => {},
  };
  sessions.set(session.id, session);

  let browser: CdpBrowser | null = null;
  try {
    browser = await CdpBrowser.launch();
  } catch (err: any) {
    session.status = "error";
    session.message = err?.message || "启动浏览器失败";
    sessions.delete(session.id);
    throw err;
  }

  const settle = (status: DouyinLoginStatus, message: string, cookie?: string) => {
    if (session.status === "completed" || session.status === "expired") return;
    session.status = status;
    session.message = message;
    if (cookie) session.cookie = cookie;
  };

  browser.onQrCode = ({ qrcode }) => {
    session.qrcode = qrcode!.startsWith("data:") ? qrcode : `data:image/png;base64,${qrcode}`;
    if (session.status !== "scanned") {
      session.status = "waiting";
      session.message = "请使用抖音App扫描二维码";
    }
  };

  browser.onCheck = ({ status: code }) => {
    if (code === 2) {
      session.status = "scanned";
      session.message = "已扫描，请在手机上确认登录";
    } else if (code === 5) {
      settle("expired", "二维码已过期，请点击重新获取");
    } else if (code === 3) {
      session.status = "scanned";
      session.message = "登录确认中";
      // 等待跳转写入 cookie
      const started = Date.now();
      const timer = setInterval(async () => {
        try {
          const cookies = await browser!.getCookies();
          const hasSession = cookies.some((c) => c.name === "sessionid" || c.name === "sessionid_ss");
          if (hasSession) {
            clearInterval(timer);
            const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
            settle("completed", "登录成功", cookieStr);
            logger.info("[douyin-login] 扫码登录成功");
            setTimeout(() => {
              sessions.delete(session.id);
              browser!.close();
            }, 30000);
          } else if (Date.now() - started > 20000) {
            clearInterval(timer);
            settle("error", "登录确认超时，请重试");
          }
        } catch {
          clearInterval(timer);
          settle("error", "获取登录 Cookie 失败");
        }
      }, 1500);
    }
  };

  session.cleanup = async () => {
    sessions.delete(session.id);
    browser?.close();
  };

  // 5 分钟超时
  setTimeout(async () => {
    if (sessions.get(session.id) === session && session.status !== "completed") {
      settle("expired", "二维码已过期，请点击重新获取");
      await session.cleanup();
    }
  }, 5 * 60 * 1000);

  await browser.openLoginPage(DOUYIN_LOGIN_URL);
  return session;
}

export function getDouyinSession(id: string): DouyinSession | undefined {
  return sessions.get(id);
}

export async function cancelDouyinSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (s) {
    sessions.delete(id);
    await s.cleanup();
  }
}
