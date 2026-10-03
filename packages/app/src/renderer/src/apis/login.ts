import request from "./request";

export interface QrLoginCreateResult {
  ok: boolean;
  error?: string;
  data?: {
    id: string;
    status?: string;
    message?: string;
    /** 斗鱼：二维码内容 URL（前端渲染二维码） */
    qrUrl?: string;
    /** 抖音：二维码图片（dataURL） */
    qrcode?: string;
    expire?: number;
  };
}

export interface QrLoginCheckResult {
  ok: boolean;
  error?: string;
  data?: {
    status: "waiting" | "scanned" | "completed" | "expired" | "cancelled" | "error";
    message?: string;
    qrcode?: string;
    cookie?: string;
  };
}

/**
 * 获取扫码登录二维码（仅 web 模式使用）
 */
const getQrcode = async (
  platform: "douyu" | "douyin",
): Promise<QrLoginCreateResult> => {
  const res = await request.get(`/login/${platform}/qrcode`);
  return res.data;
};

/**
 * 轮询扫码登录状态
 */
const check = async (platform: "douyu" | "douyin", id: string): Promise<QrLoginCheckResult> => {
  const res = await request.get(`/login/${platform}/check`, { params: { id } });
  return res.data;
};

/**
 * 取消扫码登录
 */
const cancel = async (platform: "douyu" | "douyin", id: string): Promise<void> => {
  await request.get(`/login/${platform}/cancel`, { params: { id } });
};

export default {
  getQrcode,
  check,
  cancel,
};
