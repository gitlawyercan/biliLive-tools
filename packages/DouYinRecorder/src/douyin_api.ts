import { URL, URLSearchParams } from "url";
import https from "https";
import axios from "axios";
import { isEmpty } from "lodash-es";
import { assert, get__ac_signature } from "./utils.js";
import { ABogus } from "./sign.js";
import {
  getPooledTtwidCookie,
  refillTtwidPoolInBackground,
  getTtwidPoolStatus,
} from "./ttwidPool.js";
import { DOUYIN_UA, DOUYIN_CLIENT_HINTS, DOUYIN_DOCUMENT_HEADERS } from "./douyin_headers.js";
import type { APIType, RoomInfo, RealAPIType } from "./types.js";

// 【#6 TLS 观察哨+预案】
// 观察哨：web/enter 携带合法 ttwid 仍批量失败（403/空响应）时告警 —— 这是抖音
// 收紧 TLS 指纹检测的信号，届时应启用下面的硬化开关。
// 预案：设置环境变量 DOUYIN_TLS_HARDEN=1 后，请求走对齐 Chrome 的 https.Agent
//（密码套件顺序 + ALPN）。注意 a_bogus 与 TLS 层无关，签名层无需改动。
const TLS_HARDEN_ENABLED = process.env.DOUYIN_TLS_HARDEN === "1";
let tlsWarnCounter = 0;
let tlsWarnEmitted = false;

// 【#6 TLS 观察哨】web/enter 携带合法 ttwid 仍连续失败 ≥10 次 → 告警一次。
// 这是抖音收紧 TLS/JA3 检测的典型信号：签名与 cookie 都正常但握手被拒。
// 处置：开启 DOUYIN_TLS_HARDEN=1（上面的硬化 Agent），或更换出口 IP 复测。
function noteWebEnterFailureWithTtwid(): void {
  tlsWarnCounter++;
  if (tlsWarnCounter >= 10 && !tlsWarnEmitted) {
    tlsWarnEmitted = true;
    console.warn(
      "[DouYin][TLS 观察哨] web/enter 携带合法 ttwid 已连续失败 %d 次（403/异常响应）。" +
        "疑似抖音收紧了 TLS 指纹检测，建议：1) 设置 DOUYIN_TLS_HARDEN=1 启用硬化 Agent；" +
        "2) 更换出口 IP 复测；3) 观察同 IP 下 B 站/其他平台是否正常以确认是抖音侧限制。",
      tlsWarnCounter,
    );
  }
}

const requester = axios.create({
  timeout: 10e3,
  // axios 会自动读取环境变量中的 http_proxy 和 https_proxy 并应用，这会让请求发往代理的 host。
  // 所以这里需要主动禁用代理功能。
  proxy: false,
  headers: {
    "User-Agent": DOUYIN_UA,
  },
  ...(TLS_HARDEN_ENABLED
    ? {
        httpsAgent: new https.Agent({
          ALPNProtocols: ["h2", "http/1.1"],
          minVersion: "TLSv1.2",
          // Chrome 130 常用套件顺序（尽力对齐，无法覆盖 JA3 全部维度）
          ciphers: [
            "TLS_AES_128_GCM_SHA256",
            "TLS_AES_256_GCM_SHA384",
            "TLS_CHACHA20_POLY1305_SHA256",
            "ECDHE-ECDSA-AES128-GCM-SHA256",
            "ECDHE-RSA-AES128-GCM-SHA256",
            "ECDHE-ECDSA-AES256-GCM-SHA384",
            "ECDHE-RSA-AES256-GCM-SHA384",
            "ECDHE-ECDSA-CHACHA20-POLY1305",
            "ECDHE-RSA-CHACHA20-POLY1305",
          ].join(":"),
        }),
      }
    : {}),
});

/**
 * 从抖音短链接解析得到直播间ID
 * @param shortURL 短链接，如 https://v.douyin.com/DpfoBLAXoHM/
 * @returns webRoomId 直播间ID
 */
export async function resolveShortURL(shortURL: string): Promise<string> {
  // 获取跳转后的页面内容
  const response = await requester.get(shortURL);
  const redirectedURL = response.request.res.responseUrl;
  if (redirectedURL.includes("/user/")) {
    const secUid = new URL(redirectedURL).searchParams.get("sec_uid");
    if (!secUid) {
      throw new Error("无法从短链接解析出直播间ID");
    }
    return parseUser(`https://www.douyin.com/user/${secUid}`);
  }

  // 尝试从页面内容中提取webRid
  const webRidMatch = response.data.match(/"webRid\\":\\"(\d+)\\"/);
  if (webRidMatch) {
    return webRidMatch[1];
  }

  throw new Error("无法从短链接解析出直播间ID");
}

const qualityList = [
  {
    key: "origin",
    desc: "原画",
  },
  {
    key: "uhd",
    desc: "蓝光",
  },
  {
    key: "hd",
    desc: "超清",
  },
  {
    key: "sd",
    desc: "高清",
  },
  {
    key: "ld",
    desc: "标清",
  },
  {
    key: "ao",
    desc: "音频流",
  },
  {
    key: "real_origin",
    desc: "真原画",
  },
];

let cookieCache: {
  startTimestamp: number;
  cookies: string;
};

/**
 * 【#1 官方 ttwid 注册 + #4 ttwid 池】
 * 优先走官方注册接口签发的 ttwid（真 token、365 天有效，池内 12~36h 抖动轮换），
 * 失败时回退旧链路（抓首页 → __ac_signature → ttwid）。
 *
 * 2026-10 实测：官方 ttwid 调 webcast/room/web/enter 直接 status_code=0，
 * 该接口不强制 a_bogus，ttwid cookie 是硬性要求。
 */
export const getCookie = async (): Promise<string> => {
  try {
    const cookie = await getPooledTtwidCookie();
    // 后台补池（fire-and-forget），保持池中始终有 2~3 个可用 token
    refillTtwidPoolInBackground();
    return cookie;
  } catch (error) {
    console.warn(
      "[DouYin][ttwidPool] 官方 ttwid 不可用，回退旧抓取链路:",
      error instanceof Error ? error.message : error,
    );
    return getLegacyCookie();
  }
};

/**
 * 旧链路（保底）：请求首页从 set-cookie 换取含 ttwid 的 cookie 串
 */
const getLegacyCookie = async (): Promise<string> => {
  const now = new Date().getTime();
  // 缓存6小时
  if (cookieCache?.startTimestamp && now - cookieCache.startTimestamp < 6 * 60 * 60 * 1000) {
    return cookieCache.cookies;
  }
  const res = await requester.get("https://live.douyin.com/", {
    headers: {
      // 直接打开首页：无 Referer、sec-fetch-site 为 none
      "sec-fetch-site": "none",
      ...DOUYIN_DOCUMENT_HEADERS,
    },
  });
  if (!res.headers["set-cookie"]) {
    throw new Error("No cookie in response");
  }
  const cookies = (res.headers["set-cookie"] ?? [])
    .map((cookie) => {
      return cookie.split(";")[0];
    })
    .join("; ");

  if (!cookies.includes("ttwid")) {
    // 如果不含ttwid，且已经存在含ttwid的cookie，将缓存时间直接增加1小时，复用之前的参数
    if (cookieCache?.cookies) {
      cookieCache.startTimestamp += 60 * 60 * 1000; // 增加1小时
      return cookieCache.cookies;
    }
  }

  cookieCache = {
    startTimestamp: now,
    cookies,
  };
  return cookies;
};

/** ttwid 池状态（诊断用） */
export const describeTtwidPool = () => getTtwidPoolStatus();

function generateNonce() {
  // 21味随机字母数字组合
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let nonce = "";
  for (let i = 0; i < 21; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * 随机选择一个可用的 API 接口
 * @returns 随机选择的 API 类型
 */
export function selectRandomAPI(exclude?: RealAPIType[]): RealAPIType {
  const availableAPIs: Array<RealAPIType> = ["web", "webHTML", "mobile", "userHTML"];
  if (exclude && exclude.length > 0) {
    for (const api of exclude) {
      const index = availableAPIs.indexOf(api);
      if (index !== -1) {
        availableAPIs.splice(index, 1);
      }
    }
  }
  const randomIndex = Math.floor(Math.random() * availableAPIs.length);
  return availableAPIs[randomIndex];
}

/**
 * 通过解析用户html页面来获取房间数据
 * @param secUserId
 * @param opts
 */
async function getRoomInfoByUserWeb(
  secUserId: string,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  const url = `https://www.douyin.com/user/${secUserId}`;
  const ua = DOUYIN_UA;
  let nonce = "068ea1c0100bb2c06590f";

  try {
    nonce = await getNonce(url);
  } catch (error) {
    console.warn("获取nonce失败，使用默认值", error);
  }

  let cookies: string | undefined = undefined;
  if (opts.auth) {
    cookies = opts.auth;
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = get__ac_signature(timestamp, url, nonce, ua);
    cookies = `__ac_nonce=${nonce}; __ac_signature=${signed}; __ac_referer=__ac_blank`;
  }

  const res = await requester.get(url, {
    headers: {
      "User-Agent": ua,
      // 直接打开用户页：无 Referer、sec-fetch-site 为 none
      "sec-fetch-site": "none",
      ...DOUYIN_DOCUMENT_HEADERS,
      cookie: cookies,
    },
  });

  if (res.data.includes("验证码")) {
    throw new Error("需要验证码，请在浏览器中打开链接获取" + url);
  }
  if (!res.data.includes("抖音号")) {
    throw new Error("userHTML页面没有正常加载" + String(res.data));
  }
  if (!res.data.includes("直播中")) {
    return {
      living: false,
      isLiveRadio: false,
      nickname: "",
      sec_uid: "",
      avatar: "",
      api: "userHTML",
      room: null,
    };
  }

  const userRegex = /(\{\\"user\\":.*?)\]\\n"\]\)/;
  // fs.writeFileSync("douyin.html", res.data);
  const userMatch = res.data.match(userRegex);

  if (!userMatch) {
    throw new Error("No match found in HTML");
  }
  let userJsonStr = userMatch[1];
  userJsonStr = userJsonStr
    .replace(/\\"/g, '"')
    .replace(/\\"/g, '"')
    .replace(/"\$\w+"/g, "null");

  try {
    const userData = JSON.parse(userJsonStr);
    const roomData = userData?.user?.user?.roomData;
    const streamUrl = roomData?.stream_url;

    let liveCoreSdkData: any | string = null;
    if (streamUrl) {
      liveCoreSdkData = { live_core_sdk_data: streamUrl.live_core_sdk_data };
      if (liveCoreSdkData?.live_core_sdk_data?.pull_data) {
        const flvPullUrl = streamUrl.flv_pull_url;
        let streamData: StreamData["data"] = {};
        for (const quality of [{ key: "or4", desc: "原画" }, ...qualityList]) {
          const flvUrls = Object.values(flvPullUrl) as string[];
          if (flvUrls.some((url) => url.includes(`${quality.key}`))) {
            const url = flvUrls.find((url) => url.includes(`${quality.key}`));
            const convertedQuality = quality.key === "or4" ? "origin" : quality.key;
            streamData[convertedQuality] = {
              // @ts-ignore
              main: {
                flv: url!,
                hls: "",
              },
            };
          }
        }

        liveCoreSdkData.live_core_sdk_data.pull_data.stream_data = streamData;
      } else {
        liveCoreSdkData = null;
      }
    }

    // console.log("pppp", JSON.stringify(liveCoreSdkData, null, 2));
    // console.log(JSON.stringify(streamUrl, null, 2));
    // console.log(JSON.stringify(userData, null, 2));

    // const roomData = JSON.parse(roomJsonStr);
    // console.log(roomData);
    // const roomInfo = data.state.roomStore.roomInfo;
    // const streamData = data.state.streamStore.streamData;
    return {
      living: userData?.user?.user?.roomData?.status === 2,
      isLiveRadio: roomData?.live_type_audio ?? false,
      nickname: userData?.user?.user?.nickname ?? "",
      sec_uid: userData?.user?.user?.secUid ?? "",
      avatar: userData?.user?.user?.avatar ?? "",
      api: "userHTML",
      room: {
        title: "",
        cover: "",
        id_str: userData?.user?.user?.roomIdStr,
        stream_url: liveCoreSdkData,
      },
    };
  } catch (e) {
    console.error("Failed to parse JSON:", e);
    throw e;
  }
}

/**
 * 通过解析直播html页面来获取房间数据
 * @param webRoomId
 * @param opts
 */
async function getRoomInfoByHtml(
  webRoomId: string,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  const url = `https://live.douyin.com/${webRoomId}`;
  const ua = DOUYIN_UA;
  const nonce = generateNonce();

  let cookies: string | undefined = undefined;
  if (opts.auth) {
    cookies = opts.auth;
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = get__ac_signature(timestamp, url, nonce, ua);
    cookies = `__ac_nonce=${nonce}; __ac_signature=${signed}; __ac_referer=__ac_blank`;
  }

  const res = await requester.get(url, {
    headers: {
      "User-Agent": ua,
      // 从首页进入房间页：带首页 Referer、sec-fetch-site 为 same-origin
      Referer: "https://live.douyin.com/",
      "sec-fetch-site": "same-origin",
      ...DOUYIN_DOCUMENT_HEADERS,
      cookie: cookies,
    },
  });
  const regex = /(\{\\"state\\":.*?)\]\\n"\]\)/;
  const match = res.data.match(regex);

  if (!match) {
    throw new Error("No match found in HTML");
  }
  let jsonStr = match[1];
  jsonStr = jsonStr.replace(/\\"/g, '"');
  jsonStr = jsonStr.replace(/\\"/g, '"');
  try {
    const data = JSON.parse(jsonStr);
    const roomInfo = data.state.roomStore.roomInfo;
    const streamData = data.state.streamStore.streamData;
    const isLiveRadio = roomInfo.enter_mode == 1;
    return {
      living: roomInfo?.room?.status === 2 || isLiveRadio,
      isLiveRadio: isLiveRadio,
      nickname: roomInfo?.anchor?.nickname ?? "",
      sec_uid: roomInfo?.anchor?.sec_uid ?? "",
      avatar: roomInfo?.anchor?.avatar_thumb?.url_list?.[0] ?? "",
      api: "webHTML",
      room: {
        title: roomInfo?.room?.title ?? "",
        cover: roomInfo?.room?.cover?.url_list?.[0] ?? "",
        id_str: roomInfo?.room?.id_str ?? "",
        stream_url: roomInfo?.room?.stream_url?.pull_datas
          ? {
              pull_datas: roomInfo?.room?.stream_url?.pull_datas,
              live_core_sdk_data: {
                pull_data: {
                  options: { qualities: streamData.H264_streamData?.options?.qualities ?? [] },
                  stream_data: streamData.H264_streamData?.stream ?? {},
                },
              },
            }
          : null,
      },
    };
  } catch (e) {
    console.error("Failed to parse JSON:", e);
    throw e;
  }
}

async function getRoomInfoByWeb(
  webRoomId: string,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  let cookies: string | undefined = undefined;
  if (opts.auth) {
    cookies = opts.auth;
  } else {
    // 抖音的 'webcast/room/web/enter' api 会需要 ttwid 的 cookie，这个 cookie 是由这个请求的响应头设置的，
    // 所以在这里请求一次自动设置。
    cookies = await getCookie();
  }

  const params: Record<any, any> = {
    aid: 6383,
    live_id: 1,
    device_platform: "web",
    language: "zh-CN",
    enter_from: "web_live",
    cookie_enabled: "true",
    screen_width: 1920,
    screen_height: 1080,
    browser_language: "zh-CN",
    // 与 UA（Windows / Chrome 130）严格一致：此前 MacIntel + 108 与 UA 自相矛盾
    browser_platform: "Win32",
    browser_name: "Chrome",
    browser_version: "130.0.0.0",
    web_rid: webRoomId,
    "Room-Enter-User-Login-Ab": 0,
    is_need_double_stream: "false",
  };

  const abogus = new ABogus();
  const [query, _, ua] = abogus.generateAbogus(new URLSearchParams(params).toString(), "");

  let res;
  try {
    res = await requester.get<EnterRoomApiResp>(
      `https://live.douyin.com/webcast/room/web/enter/?${query}`,
      {
        headers: {
          cookie: cookies,
          "User-Agent": ua,
          // 页面内 XHR 请求的真实浏览器头部（a_bogus 只签 query + UA，补头不影响签名）
          Referer: `https://live.douyin.com/${webRoomId}`,
          Accept: "application/json, text/plain, */*",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          ...DOUYIN_CLIENT_HINTS,
        },
      },
    );
    // 【#6 TLS 观察哨】成功即清零计数
    tlsWarnCounter = 0;
  } catch (error) {
    if (typeof cookies === "string" && cookies.includes("ttwid=")) {
      noteWebEnterFailureWithTtwid();
    }
    throw error;
  }
  if (res.data.status_code !== 0 && res.data.status_code !== 30003) {
    if (typeof cookies === "string" && cookies.includes("ttwid=")) {
      noteWebEnterFailureWithTtwid();
    }
  }
  if (res.data.status_code === 30003) {
    // 直播已结束
    return {
      living: false,
      isLiveRadio: false,
      nickname: "",
      sec_uid: "",
      avatar: "",
      api: "web",
      room: {
        title: "",
        cover: "",
        id_str: "",
        stream_url: null,
      },
    };
  }
  assert(
    res.data.status_code === 0,
    `Unexpected resp, code ${res.data.status_code}, msg ${JSON.stringify(res.data.data)}, id ${webRoomId}, cookies: ${cookies}`,
  );

  const data = res.data.data;
  const room = data?.data?.[0];

  return {
    living: data?.room_status === 0 || data?.room_status === 1,
    isLiveRadio: data?.room_status === 1,
    nickname: data?.user?.nickname ?? "",
    avatar: data?.user?.avatar_thumb?.url_list?.[0] ?? "",
    sec_uid: data?.user?.sec_uid ?? "",
    api: "web",
    room: {
      title: room?.title ?? "",
      cover: room?.cover?.url_list?.[0] ?? "",
      id_str: room?.id_str ?? "",
      stream_url: room?.stream_url,
    },
  };
}

// 【#5 msToken/verifyFp 指纹】
// 2026-10 实测：reflow/info 带"登录 cookie 也返回 10011"，三件套不是限流的解药；
// 但补全它们能消除"请求特征缺失"这一可被指纹化的弱点（上游 PR #180 的 mobile
// 实现即 verifyFp + msToken + a_bogus 三件套思路）。指纹 24h 轮换，与 UA 严格一致。
interface MobileFingerprint {
  verifyFp: string;
  msToken: string;
  createdAt: number;
}
const MOBILE_FP_TTL = 24 * 60 * 60 * 1000;
let mobileFingerprint: MobileFingerprint | null = null;

/** s_v_web_id / verifyFp 标准格式（无签名校验，格式正确即可） */
function genVerifyFp(): string {
  const seg = (n: number) => {
    const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
    let s = "";
    for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  };
  return `verify_${seg(8)}_${seg(8)}_${seg(4)}_${seg(4)}_${seg(4)}_${seg(12)}`;
}

/** msToken：116 位随机串（真实浏览器中为服务端下发，此处自造并按时轮换） */
function genMsToken(len = 116): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=";
  let s = "";
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function getMobileFingerprint(): MobileFingerprint {
  if (!mobileFingerprint || Date.now() - mobileFingerprint.createdAt > MOBILE_FP_TTL) {
    mobileFingerprint = {
      verifyFp: genVerifyFp(),
      msToken: genMsToken(),
      createdAt: Date.now(),
    };
  }
  return mobileFingerprint;
}

async function getRoomInfoByMobile(
  secUserId: string | number,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  if (!secUserId) {
    console.error(opts);
    throw new Error("Mobile API need secUserId, please set uid field");
  }
  if (typeof secUserId === "number") {
    throw new Error("Mobile API need secUserId string, please set uid field");
  }
  // 【#5】补全 verifyFp + msToken（24h 轮换的持久化指纹），消除请求特征缺失
  const fingerprint = getMobileFingerprint();
  const params: Record<any, any> = {
    app_id: 1128,
    live_id: 1,
    verifyFp: fingerprint.verifyFp,
    room_id: 2,
    type_id: 0,
    msToken: fingerprint.msToken,
    sec_user_id: secUserId,
  };

  const res = await requester.get<EnterRoomApiResp>(
    `https://webcast.amemv.com/webcast/room/reflow/info/`,
    {
      params,
      headers: {
        // cookie: opts.auth,
      },
    },
  );

  // @ts-ignore
  const room = res?.data?.data?.room;
  return {
    living: room?.status === 2,
    isLiveRadio: room?.live_type_audio ?? false,
    nickname: room?.owner?.nickname,
    sec_uid: room?.owner?.sec_uid,
    avatar: room?.owner?.avatar_thumb?.url_list?.[0],
    api: "mobile",
    room: {
      title: room?.title,
      cover: room?.cover?.url_list?.[0],
      id_str: room?.id_str,
      stream_url: room?.stream_url,
    },
  };
}

export async function getRoomInfo(
  webRoomId: string,
  opts: {
    auth?: string;
    doubleScreen?: boolean;
    api?: APIType;
    uid?: string | number;
  } = {},
): Promise<{
  living: boolean;
  // 是否为直播电台
  isLiveRadio?: boolean;
  roomId: string;
  owner: string;
  title: string;
  streams: StreamProfile[];
  sources: SourceProfile[];
  avatar: string;
  cover: string;
  liveId: string;
  uid: string;
  api: RealAPIType;
}> {
  let data: RoomInfo;
  let api = opts.api ?? "web";

  // 如果选择了 random，则随机选择一个可用的接口
  if (api === "random") {
    api = selectRandomAPI();
  }

  if (api === "mobile" || api === "userHTML") {
    // mobile 接口需要 sec_uid 参数，老数据可能没有，实现兼容
    if (!opts.uid || typeof opts.uid !== "string") {
      api = "web";
    }
  }
  if (api === "webHTML") {
    data = await getRoomInfoByHtml(webRoomId, opts);
  } else if (api === "mobile") {
    data = await getRoomInfoByMobile(opts.uid as string, opts);
  } else if (api === "userHTML") {
    data = await getRoomInfoByUserWeb(opts.uid as string, opts);
  } else {
    data = await getRoomInfoByWeb(webRoomId, opts);
  }

  const room = data.room;

  assert(room, `No room data, id ${webRoomId}`);

  if (!room?.stream_url) {
    return {
      living: data.living,
      isLiveRadio: data.isLiveRadio,
      roomId: webRoomId,
      owner: data.nickname,
      title: room?.title ?? data.nickname,
      streams: [],
      sources: [],
      avatar: data.avatar,
      cover: room?.cover ?? "",
      liveId: room?.id_str ?? "",
      uid: data.sec_uid,
      api: data.api,
    };
  }

  let qualities: QualityInfo[] = [];
  let stream_data: string = "";
  if (opts.doubleScreen && !isEmpty(room.stream_url.pull_datas)) {
    const pull_data = Object.values(room.stream_url.pull_datas)[0] ?? {
      options: {
        qualities: [],
      },
      stream_data: "",
    };
    // @ts-ignore
    qualities = pull_data.options.qualities;
    // @ts-ignore
    stream_data = pull_data.stream_data;
  }
  if (!stream_data) {
    qualities = room.stream_url.live_core_sdk_data.pull_data.options.qualities;
    stream_data = room.stream_url.live_core_sdk_data.pull_data.stream_data;
  }
  const streamData =
    typeof stream_data === "string" ? (JSON.parse(stream_data) as StreamData).data : stream_data;

  const streams: StreamProfile[] = qualities.map((info) => ({
    desc: info.name,
    key: info.sdk_key,
    bitRate: info.v_bit_rate,
  }));

  // 转换流数据结构
  const streamList: StreamInfo[] = Object.entries(streamData)
    .map(([quality, info]) => {
      const stream = info?.main;
      const name = qualityList.find((item) => item.key === quality)?.desc;
      return {
        quality: quality,
        name: name ?? "未知",
        flv: stream?.flv,
        hls: stream?.hls,
      };
    })
    .filter((stream) => stream.flv || stream.hls);

  const aoStream = streamList.find((stream) => stream.quality === "ao");
  if (!!aoStream) {
    // 真原画流是在ao流中拿到的
    streamList.push({
      quality: "real_origin",
      name: "真原画",
      flv: (aoStream?.flv ?? "").replace("&only_audio=1", ""),
      hls: (aoStream?.hls ?? "").replace("&only_audio=1", ""),
    });
  }
  streamList.sort((a, b) => {
    const aIndex = qualityList.findIndex((item) => item.key === a.quality);
    const bIndex = qualityList.findIndex((item) => item.key === b.quality);
    // 如果找不到对应的质量等级，将其排在最后
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  // 看起来抖音是自动切换 cdn 的，所以这里固定返回一个默认的 source。
  const sources: SourceProfile[] = [
    {
      name: "自动",
      streamMap: streamData,
      streams: streamList,
    },
  ];

  // console.log(JSON.stringify(sources, null, 2), qualities);

  return {
    living: data.living,
    isLiveRadio: data.isLiveRadio,
    roomId: webRoomId,
    owner: data.nickname,
    title: room.title,
    streams,
    sources,
    avatar: data.avatar,
    cover: room.cover,
    liveId: room.id_str,
    uid: data.sec_uid,
    api: data.api,
  };
}

let nonceCache: {
  startTimestamp: number;
  nonce: string;
};

/**
 * 获取nonce
 */
async function getNonce(url: string) {
  const now = new Date().getTime();
  // 缓存6小时
  if (nonceCache?.startTimestamp && now - nonceCache.startTimestamp < 6 * 60 * 60 * 1000) {
    return nonceCache.nonce;
  }
  const res = await requester.get(url);
  if (!res.headers["set-cookie"]) {
    throw new Error("No cookie in response");
  }
  const cookies = {};
  (res.headers["set-cookie"] ?? []).forEach((cookie) => {
    const [key, _] = cookie.split(";");
    const [keyPart, valuePart] = key.split("=");
    if (!keyPart || !valuePart) return;
    cookies[keyPart.trim()] = valuePart.trim();
  });
  const nonce = cookies["__ac_nonce"];
  if (nonce) {
    nonceCache = {
      startTimestamp: now,
      nonce: nonce,
    };
  }
  return nonce;
}

/**
 * 解析抖音号
 * @param url
 */
export async function parseUser(url: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0";
  const nonce = (await getNonce(url)) ?? generateNonce();
  const signed = get__ac_signature(timestamp, url, nonce, ua);

  const res = await requester.get(url, {
    headers: {
      "User-Agent": ua,
      cookie: `__ac_nonce=${nonce}; __ac_signature=${signed}`,
    },
  });
  const text = res.data;
  const regex = /\\"uniqueId\\":\\"(.*?)\\"/;
  const match = text.match(regex);
  if (match && match[1]) {
    return match[1];
  }

  return null;
}

export interface StreamProfile {
  desc: string;
  key: string;
  bitRate: number;
}

export interface StreamInfo {
  quality: string;
  name: string;
  flv?: string;
  hls?: string;
}

export interface SourceProfile {
  name: string;
  streamMap: StreamData["data"];
  streams: StreamInfo[];
}

interface EnterRoomApiResp {
  data: {
    data: [
      | undefined
      | {
          id_str: string;
          status: number;
          status_str: string;
          title: string;
          user_count_str: string;
          cover: {
            url_list: string[];
          };
          stream_url?: {
            flv_pull_url: PullURLMap;
            default_resolution: string;
            hls_pull_url_map: PullURLMap;
            hls_pull_url: string;
            stream_orientation: number;
            live_core_sdk_data: {
              pull_data: {
                options: {
                  default_quality: QualityInfo;
                  qualities: QualityInfo[];
                };
                stream_data: string;
              };
            };
            extra: {
              height: number;
              width: number;
              fps: number;
              max_bitrate: number;
              min_bitrate: number;
              default_bitrate: number;
              bitrate_adapt_strategy: number;
              anchor_interact_profile: number;
              audience_interact_profile: number;
              hardware_encode: boolean;
              video_profile: number;
              h265_enable: boolean;
              gop_sec: number;
              bframe_enable: boolean;
              roi: boolean;
              sw_roi: boolean;
              bytevc1_enable: boolean;
            };
            pull_datas: Record<
              string,
              {
                options: {
                  qualities: QualityInfo[];
                };
                stream_data: string;
              }
            >;
          };
          mosaic_status: number;
          mosaic_status_str: string;
          admin_user_ids: number[];
          admin_user_ids_str: string[];
          owner: UserInfo;
          room_auth: unknown;
          live_room_mode: number;
          stats: {
            total_user_desp: string;
            like_count: number;
            total_user_str: string;
            user_count_str: string;
          };
          has_commerce_goods: boolean;
          linker_map: {};
          linker_detail: unknown;
          room_view_stats: {
            is_hidden: boolean;
            display_short: string;
            display_middle: string;
            display_long: string;
            display_value: number;
            display_version: number;
            incremental: boolean;
            display_type: number;
            display_short_anchor: string;
            display_middle_anchor: string;
            display_long_anchor: string;
          };
          scene_type_info: unknown;
          toolbar_data: unknown;
          room_cart: unknown;
        },
    ];
    enter_room_id: string;
    extra?: {
      digg_color: string;
      pay_scores: string;
      is_official_channel: boolean;
      signature: string;
    };
    user: UserInfo;
    qrcode_url: string;
    enter_mode: number;
    room_status: number;
    partition_road_map?: unknown;
    similar_rooms: unknown[];
    shark_decision_conf: string;
    web_stream_url?: unknown;
  };
  extra: { now: number };
  status_code: number;
}

type PullURLMap = Record<string, string>;

interface QualityInfo {
  name: string;
  sdk_key: string;
  v_codec: string;
  resolution: string;
  level: number;
  v_bit_rate: number;
  additional_content: string;
  fps: number;
  disable: number;
}

interface UserInfo {
  id_str: string;
  sec_uid: string;
  nickname: string;
  avatar_thumb: {
    url_list: string[];
  };
  follow_info: { follow_status: number; follow_status_str: string };
}

interface StreamData {
  common: unknown;
  data: Record<
    string,
    {
      main: {
        flv: string;
        hls: string;
        cmaf: string;
        dash: string;
        lls: string;
        tsl: string;
        tile: string;
        sdk_params: string;
      };
    }
  >;
}
