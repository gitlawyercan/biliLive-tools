import request from "./request";
import { configApi } from ".";

import type { Task } from "@renderer/types";
import type {
  DanmuPreset,
  FfmpegOptions,
  HotProgressOptions,
  BiliupPreset,
  DanmaOptions,
} from "@biliLive-tools/types";
import type { VideoAPI } from "@biliLive-tools/http/types/video.js";
import type { DetectionConfig } from "music-segment-detector";

/**
 * 获取任务列表
 */
const list = async (params: {
  type?: string;
}): Promise<{ list: Task[]; runningTaskNum: number }> => {
  const res = await request.get(`/task`, { params });
  return res.data;
};

/**
 * 获取任务
 */
const get = async (id: string): Promise<Task> => {
  const res = await request.get(`/task/${id}`);
  return res.data;
};

const pause = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/pause`);
  return res.data;
};

const resume = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/resume`);
  return res.data;
};

const cancel = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/kill`);
  return res.data;
};

const interrupt = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/interrupt`);
  return res.data;
};

const removeRecord = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/removeRecord`);
  return res.data;
};

const removeFile = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/removeFile`);
  return res.data;
};

const restart = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/restart`);
  return res.data;
};

// 批量删除
const removeBatch = async (ids: string[]): Promise<string> => {
  const res = await request.post(`/task/removeBatch`, { ids });
  return res.data;
};

const start = async (id: string): Promise<string> => {
  const res = await request.post(`/task/${id}/start`);
  return res.data;
};

const convertXml2Ass = async (
  input: string,
  output: string,
  preset: DanmuPreset["config"],
  options: DanmaOptions & {
    sync?: boolean;
  },
): Promise<{
  taskId: string;
  output: string;
}> => {
  const res = await request.post(`/task/convertXml2Ass`, {
    input,
    output,
    options,
    preset,
  });
  return res.data;
};

const mergeVideos = async (
  inputVideos: string[],
  options: {
    // 如果存在output，那么其他的文件参数都被忽略
    output?: string;
    saveOriginPath: boolean;
    keepFirstVideoMeta: boolean;
  },
): Promise<string> => {
  const res = await request.post(`/task/mergeVideo`, {
    inputVideos,
    options,
  });
  return res.data;
};

const checkMergeVideos = async (
  inputVideos: string[],
): Promise<{
  warnings: string[];
  errors: string[];
}> => {
  const res = await request.post(`/task/checkMergeVideos`, { inputVideos });
  return res.data;
};

export interface VideoGroupFile {
  path: string;
  name: string;
  timestamp: number;
}

export interface VideoGroup {
  name: string;
  /** 净化后的输出文件名主干（剔除 emoji、非法字符），与合并输出一致 */
  outputName: string;
  isFinished: boolean;
  files: VideoGroupFile[];
  count: number;
  sizeBytes: number;
}

/**
 * 扫描目录并按「前缀_日期」分组
 */
const scanVideoGroups = async (
  inputDir: string,
  options: { recursive?: boolean; excludeDirs?: string[] } = {},
): Promise<{ groups: VideoGroup[] }> => {
  const res = await request.post(`/task/scanVideoGroups`, {
    inputDir,
    ...options,
  });
  return res.data;
};

/**
 * 分组批量合并，每个分组一个合并任务；单文件分组直接移动重命名
 */
const mergeVideoGroups = async (data: {
  groups: { name: string; files: string[] }[];
  outputDir?: string;
  autoPrefix?: string;
  /** 多文件分组合并成功后移除源文件（进回收站） */
  removeOrigin?: boolean;
}): Promise<{
  results: { name: string; taskId?: string; output?: string; error?: string }[];
}> => {
  const res = await request.post(`/task/mergeVideoGroups`, data);
  return res.data;
};

export type TimeBatchArchiveStatus = "ready" | "inBatchDir" | "unrecognized" | "conflict" | "recent";

export interface TimeBatchArchiveItem {
  path: string;
  name: string;
  sizeBytes: number;
  recordTime: number | null;
  batchFolder: string | null;
  targetPath: string | null;
  status: TimeBatchArchiveStatus;
  reason?: string;
}

export interface TimeBatchArchiveOptions {
  inputDir: string;
  recursive?: boolean;
  excludeDirs?: string[];
  recentMinutes?: number;
}

/** 扫描目录生成批次归档计划（不移动文件） */
const scanTimeBatchArchive = async (
  options: TimeBatchArchiveOptions,
): Promise<{
  items: TimeBatchArchiveItem[];
  timeBatch: { firstStart: string; secondStart: string; enabled: boolean };
}> => {
  const res = await request.post(`/task/scanTimeBatchArchive`, options);
  return res.data;
};

/** 执行批次归档：后端重新扫描后移动可归档文件 */
const runTimeBatchArchive = async (
  options: TimeBatchArchiveOptions,
): Promise<{
  results: { path: string; target?: string; batchFolder?: string | null; historyUpdated?: boolean; error?: string }[];
  timeBatch: { firstStart: string; secondStart: string; enabled: boolean };
}> => {
  const res = await request.post(`/task/runTimeBatchArchive`, options);
  return res.data;
};

const transcode = async (
  input: string,
  /** 包含后缀 */
  outputName: string,
  ffmpegOptions: FfmpegOptions,
  options: {
    override?: boolean;
    removeOrigin?: boolean;
    /** 支持绝对路径和相对路径 */
    savePath?: string;
    /** 1: 保存到原始文件夹，2：保存到特定文件夹 */
    saveType: 1 | 2;
  },
) => {
  const res = await request.post(`/task/transcode`, {
    input,
    outputName,
    ffmpegOptions,
    options,
  });
  return res.data;
};

const burn = async (
  files: { videoFilePath: string; subtitleFilePath: string },
  output: string,
  options: {
    danmaOptions: DanmuPreset["config"];
    ffmpegOptions: FfmpegOptions;
    hotProgressOptions: Omit<HotProgressOptions, "videoPath">;
    hasHotProgress: boolean;
    override?: boolean;
    removeOrigin?: boolean;
    /** 支持绝对路径和相对路径 */
    savePath?: string;
    /** 1: 保存到原始文件夹，2：保存到特定文件夹 */
    saveType?: 1 | 2;
    uploadOptions?: {
      removeOriginAfterUploadCheck: boolean;
      upload: boolean;
      config: BiliupPreset["config"];
      filePath: string;
      uid: number;
      aid?: number;
    };
  },
) => {
  const res = await request.post(`/task/burn`, {
    files,
    output,
    options,
  });
  return res.data;
};

const flvRepair = async (
  input: string,
  output: string,
  options: {
    type: "bililive" | "mesio";
    /** 支持绝对路径和相对路径 */
    savePath?: string;
    /** 1: 保存到原始文件夹，2：保存到特定文件夹 */
    saveType?: 1 | 2;
  },
) => {
  const res = await request.post(`/task/flvRepair`, {
    input,
    output,
    options,
  });
  return res.data;
};

const cut = async (
  files: { videoFilePath: string; assFilePath?: string; srtContent?: string },
  output: string,
  ffmpegOptions: FfmpegOptions,
  options: {
    override?: boolean;
    /** 支持绝对路径和相对路径 */
    savePath?: string;
    /** 1: 保存到原始文件夹，2：保存到特定文件夹 */
    saveType?: 1 | 2;
    uploadOptions?: {
      upload: boolean;
      config: BiliupPreset["config"] | null;
      filePath: string;
      uid: number | undefined;
    };
  },
) => {
  const res = await request.post(`/task/cut`, {
    files,
    output,
    options,
    ffmpegOptions,
  });
  return res.data;
};

const sendToWebhook = async (data: {
  event: "FileOpening" | "FileClosed";
  filePath: string;
  danmuPath?: string;
  roomId: string;
  time: string;
  title: string;
  username: string;
}) => {
  const res = await request.post(`/webhook/custom`, data);
  return res.data;
};

const readVideoMeta = async (input: string) => {
  const res = await request.post(`/task/videoMeta`, { file: input });
  return res.data;
};

const parseVideo = async (url: string): Promise<VideoAPI["parseVideo"]["Resp"]> => {
  const res = await request.post(`/video/parse`, { url });
  return res.data;
};

const downloadVideo = async (data: VideoAPI["downloadVideo"]["Args"]) => {
  const res = await request.post(`/video/download`, data);
  return res.data;
};

const addExtraVideoTask = async (taskId: string, filePath: string, partName: string) => {
  const res = await request.post(`/task/addExtraVideoTask`, { taskId, filePath, partName });
  return res.data;
};

const queryVideoStatus = async (taskId: string) => {
  const res = await request.post(`/task/queryVideoStatus`, { taskId });
  return res.data;
};

const editVideoPartName = async (taskId: string, partName: string) => {
  const res = await request.post(`/task/editVideoPartName`, { taskId, partName });
  return res.data;
};

const downloadFile = async (taskId: string): Promise<string> => {
  const res = await request.get(`/task/${taskId}/download`);
  const fileId = res.data;
  const fileUrl = `${request.defaults.baseURL}/assets/download/${fileId}`;

  return fileUrl;
};

const testVirtualRecord = async (
  config: any,
  folderPath: string,
  startTime?: number,
): Promise<{
  files: Array<{
    path: string;
    filename: string;
    startTimeMs: number;
    roomId?: string;
    title?: string;
    username?: string;
  }>;
}> => {
  const res = await request.post(`/task/testVirtualRecord`, {
    config,
    folderPath,
    startTime,
  });
  return res.data;
};

const executeVirtualRecord = async (
  config: any,
  folderPath: string,
  startTime?: number,
): Promise<{ success: boolean; message: string }> => {
  const res = await request.post(`/task/executeVirtualRecord`, {
    config,
    folderPath,
    startTime,
  });
  return res.data;
};

const extractPeaks = async (
  input: string,
): Promise<{
  output: {
    data: any[];
  };
}> => {
  const res = await request.post(`/task/extractPeaks`, {
    input,
    options: {
      sync: true,
    },
  });
  return res.data;
};

const analyzerWaveform = async (
  input: string,
  config?: Partial<DetectionConfig>,
): Promise<EventSource> => {
  let key = window.localStorage.getItem("key");
  if (!window.isWeb) {
    const appConfig = await configApi.get();
    key = appConfig.passKey;
  }

  const configStr = config ? encodeURIComponent(JSON.stringify(config)) : "";
  const url = `${request.defaults.baseURL}/sse/analyzerWaveform?auth=${key}&input=${encodeURIComponent(input)}&config=${configStr}`;

  const eventSource = new EventSource(url);
  return eventSource;
};

const cutSubtitle = async (data: {
  srtContent: string;
  saveType: 1 | 2;
  savePath: string;
  videoPath: string;
  segments: { start: number; end: number; name: string }[];
}) => {
  const res = await request.post(`/task/cutSubtitle`, data);
  return res.data;
};

const task = {
  list,
  get,
  pause,
  resume,
  cancel,
  interrupt,
  removeRecord,
  removeFile,
  start,
  convertXml2Ass,
  mergeVideos,
  transcode,
  burn,
  sendToWebhook,
  removeBatch,
  readVideoMeta,
  parseVideo,
  downloadVideo,
  cut,
  checkMergeVideos,
  scanVideoGroups,
  mergeVideoGroups,
  scanTimeBatchArchive,
  runTimeBatchArchive,
  addExtraVideoTask,
  downloadFile,
  editVideoPartName,
  queryVideoStatus,
  restart,
  testVirtualRecord,
  executeVirtualRecord,
  flvRepair,
  extractPeaks,
  analyzerWaveform,
  cutSubtitle,
};

export default task;
