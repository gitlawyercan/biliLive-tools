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
 *
 * 3.25.1 抖音风控专项加固（保持 CDP 直连架构不变）：
 *  1. webdriver 痕迹消除：CDP 直连无 WebDriver 层，另在每个新文档注入脚本兜底隐藏 navigator.webdriver
 *  2. UA / Client Hints / 语言 / 时区一致性：完整 userAgentMetadata 与 UA 版本严格一致，zh-CN + Asia/Shanghai
 *  3. JS 运行环境指纹补全：plugins / languages / hardwareConcurrency / deviceMemory / WebGL 厂商 / window.chrome
 *  4. 持久化浏览器 profile：默认复用固定 profile 目录（可用 DOUYIN_PROFILE_DIR 覆盖），避免"全新无痕环境"指纹；
 *     并发登录时第二个会话自动回退一次性临时目录
 *  5. 行为特征拟人：交互延迟随机化 + 页面加载后模拟少量随机鼠标移动
 *  另含三项低成本启动参数加固：--disable-blink-features=AutomationControlled、真实分辨率 1920x1080、--lang=zh-CN
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

/**
 * 环境指纹补全脚本：经 Page.addScriptToEvaluateOnNewDocument 注入，
 * 在页面所有脚本执行之前运行，补齐无头环境与真实 Windows Chrome 的差异。
 */
const STEALTH_SCRIPT = `
(() => {
  const defineProp = (obj, key, value) => {
    try {
      Object.defineProperty(obj, key, { get: () => value, configurable: true });
    } catch (e) { /* ignore */ }
  };

  // 1. webdriver 痕迹兜底（CDP 直连本应无此标识，防御性覆盖）
  defineProp(navigator, "webdriver", undefined);

  // 2. 语言 / 平台（与 UA 及 Client Hints 保持一致）
  defineProp(navigator, "languages", ["zh-CN", "zh", "en"]);
  defineProp(navigator, "platform", "Win32");

  // 3. 插件与 MIME 类型（真实 Chrome 自带 PDF 插件，无头环境为空数组是典型指纹）
  const pluginItem = (name) => {
    const item = Object.create(Plugin.prototype);
    defineProp(item, "name", name);
    defineProp(item, "filename", "internal-pdf-viewer");
    defineProp(item, "description", "Portable Document Format");
    defineProp(item, "length", 1);
    return item;
  };
  const names = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
  const plugins = Object.create(PluginArray.prototype);
  names.forEach((name, i) => { plugins[i] = pluginItem(name); });
  defineProp(plugins, "length", names.length);
  defineProp(plugins, "item", (i) => plugins[i] || null);
  defineProp(plugins, "namedItem", (n) => names.includes(n) ? pluginItem(n) : null);
  defineProp(plugins, "refresh", () => {});
  defineProp(navigator, "plugins", plugins);
  const mimeItem = Object.create(MimeType.prototype);
  defineProp(mimeItem, "type", "application/pdf");
  defineProp(mimeItem, "suffixes", "pdf");
  defineProp(mimeItem, "description", "Portable Document Format");
  const mimes = Object.create(MimeTypeArray.prototype);
  mimes[0] = mimeItem;
  defineProp(mimes, "length", 1);
  defineProp(mimes, "item", () => mimeItem);
  defineProp(mimes, "namedItem", () => mimeItem);
  defineProp(navigator, "mimeTypes", mimes);

  // 4. 硬件信息（中庸值，避免暴露容器）
  defineProp(navigator, "hardwareConcurrency", 8);
  defineProp(navigator, "deviceMemory", 8);
  defineProp(navigator, "maxTouchPoints", 0);

  // 5. WebGL 厂商 / 渲染器（无头默认 SwiftShader 是典型无头指纹）
  const spoofGetParameter = (proto) => {
    if (!proto) return;
    const original = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === 37445) return "Google Inc. (NVIDIA)"; // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)"; // UNMASKED_RENDERER_WEBGL
      return original.call(this, param);
    };
  };
  spoofGetParameter(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  spoofGetParameter(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // 6. window.chrome 对象（无头 CDP 环境下可能缺失）
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};

  // 7. permissions.query 对 Notification 返回与真实 Chrome 一致的结果
  if (window.Notification) {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery.call(window.navigator.permissions, parameters);
    }
  }
})();
`;

/** 持久化 profile 目录：环境变量优先，默认位于用户主目录下（容器内可挂载以跨重启复用） */
const resolvePersistentProfileDir = (): string => {
  return process.env.DOUYIN_PROFILE_DIR || path.join(os.homedir(), ".douyin-login-profile");
};

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
  /** 是否使用持久化 profile（持久化目录在 close 时不删除） */
  private persistentProfile = false;
  /** 持久化 profile 同一时间仅允许一个会话占用（Chromium profile 目录不可并发） */
  private static profileInUse = false;
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
    let userDataDir: string;
    let persistent = false;
    // 持久化 profile：优先复用固定目录，让抖音见到"熟悉的回头客"而非全新无痕环境；
    // 已有会话占用 profile 时（并发登录），第二个会话回退一次性临时目录
    if (!CdpBrowser.profileInUse) {
      const dir = resolvePersistentProfileDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
        userDataDir = dir;
        persistent = true;
        CdpBrowser.profileInUse = true;
      } catch {
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bililive-douyin-"));
      }
    } else {
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bililive-douyin-"));
    }
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--mute-audio",
      "--no-first-run",
      // —— 低成本风控加固三项 ——
      // 移除 Blink 自动化标记（navigator.webdriver 相关开关）
      "--disable-blink-features=AutomationControlled",
      // 真实窗口分辨率（headless 默认 800x600 本身就是 bot 信号）
      "--window-size=1920,1080",
      // 界面与请求语言环境与 UA / acceptLanguage 一致
      "--lang=zh-CN",
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ];
    const child = spawn(chromiumPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    // 启动失败时释放资源：归还持久化 profile 占用标记、清理一次性临时目录
    const releaseOnFailure = (err: Error) => {
      if (persistent) CdpBrowser.profileInUse = false;
      else fs.rm(userDataDir, { recursive: true, force: true }, () => {});
      throw err;
    };

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
    }).catch(releaseOnFailure);

    const browser = new CdpBrowser(new WebSocket(wsUrl));
    browser.child = child;
    browser.userDataDir = userDataDir;
    browser.persistentProfile = persistent;
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
    }).catch((err: Error) => {
      browser.close(); // 归还 profile 占用 / 清理临时目录
      throw err;
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
        // 行为拟人：页面加载后先模拟一段随机鼠标移动，再以随机延迟点击「二维码」登录选项卡
        void this.simulateMouseActivity().catch(() => {});
        const firstDelay = 900 + Math.floor(Math.random() * 700); // 0.9~1.6s
        const secondDelay = 2600 + Math.floor(Math.random() * 1500); // 2.6~4.1s
        setTimeout(() => void this.clickQrcodeTab(), firstDelay);
        setTimeout(() => void this.clickQrcodeTab(), secondDelay);
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
    // 注意：不调用 Runtime.enable —— 该调用会改变页面 console API 行为，是已知的
    // 自动化检测向量（rebrowser-patches 同款结论）。Runtime.evaluate 无需 enable 即可调用。
    // UA + Client Hints + 语言 + 平台一次性下发，保证与实际 Chromium 版本严格一致
    await this.send(
      "Emulation.setUserAgentOverride",
      {
        userAgent: DOUYIN_UA,
        acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
        platform: "Win32",
        userAgentMetadata: {
          brands: [
            { brand: "Not.A/Brand", version: "8" },
            { brand: "Chromium", version: "126" },
            { brand: "Google Chrome", version: "126" },
          ],
          fullVersionList: [
            { brand: "Not.A/Brand", version: "8" },
            { brand: "Chromium", version: "126" },
            { brand: "Google Chrome", version: "126" },
          ],
          fullVersion: "126.0.0.0",
          platform: "Windows",
          platformVersion: "10.0.0",
          architecture: "x86",
          bitness: "64",
          model: "",
          mobile: false,
          wow64: false,
        },
      },
      sessionId,
    );
    // 时区与登录 IP（国内）保持一致，避免 IP-时区不一致触发风控
    await this.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" }, sessionId);
    // 环境指纹补全脚本：先于页面所有脚本执行
    await this.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: STEALTH_SCRIPT },
      sessionId,
    );
    await this.send("Page.navigate", { url }, sessionId);
  }

  /** 模拟少量拟人鼠标移动（Input 域，不依赖页面脚本，随机轨迹 + 随机步进） */
  private async simulateMouseActivity() {
    if (this.ws.readyState !== WebSocket.OPEN || !this.sessionId) return;
    const startX = 300 + Math.floor(Math.random() * 500);
    const startY = 200 + Math.floor(Math.random() * 300);
    let x = startX;
    let y = startY;
    await this.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y, button: "none" },
      this.sessionId,
    );
    const steps = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < steps; i++) {
      x += Math.floor(Math.random() * 60) - 30;
      y += Math.floor(Math.random() * 30) - 15;
      await this.send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: Math.max(0, x), y: Math.max(0, y), button: "none" },
        this.sessionId,
      );
      await new Promise((r) => setTimeout(r, 80 + Math.floor(Math.random() * 150)));
    }
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
    if (this.persistentProfile) {
      // 持久化 profile 保留（下次登录复用指纹与 Cookie 缓存），仅释放占用标记
      CdpBrowser.profileInUse = false;
    } else if (this.userDataDir) {
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
