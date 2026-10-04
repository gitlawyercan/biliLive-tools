/**
 * 抖音请求头常量（douyin_api / ttwidPool 共用）
 *
 * 全链路统一 UA（与 ABogus 内置 UA 严格一致）。
 * a_bogus 使用 UA 参与签名运算，签名时的 UA 与请求头 UA 必须完全相同；
 * 此前 axios 默认 119、userHTML/roomHTML 133 Edg、ABogus 130 Edg 三种混用，
 * 是典型的客户端指纹不一致特征。
 */
export const DOUYIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

/** Client Hints 请求头（sec-ch-ua 版本与 UA 中的 Chrome/Edge 版本严格一致） */
export const DOUYIN_CLIENT_HINTS = {
  "sec-ch-ua": '"Microsoft Edge";v="130", "Chromium";v="130", "Not=A?Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
} as const;

/** 文档级导航请求头（访问 HTML 页面时使用） */
export const DOUYIN_DOCUMENT_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Upgrade-Insecure-Requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  ...DOUYIN_CLIENT_HINTS,
} as const;
