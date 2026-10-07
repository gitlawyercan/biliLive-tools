import path from "node:path";
import fse from "fs-extra";
import type { Dirent } from "node:fs";

import {
  getTimeBatchInfo,
  DEFAULT_TIME_BATCH_FIRST_START,
  DEFAULT_TIME_BATCH_SECOND_START,
} from "@bililive-tools/manager";

import { appConfig } from "../config.js";
import { updateVideoFilePath } from "../recorder/recordHistory.js";
import log from "../utils/log.js";

/**
 * 录制文件按「批次日期」归档
 *
 * 录制保存路径里已经落着大量历史文件（尤其跨夜直播会散落到第二天），
 * 本模块提供「扫描目录 → 依据文件名里的录制时间判定批次 → 移动到批次子目录」的整理能力。
 * 判定规则与录制时实时归档完全一致（复用 getTimeBatchInfo），批次边界直接读全局设置。
 *
 * 约定：
 * - 只移动视频文件本身，弹幕（.xml/.ass）、封面（.jpg）等伴生文件不移动
 * - 移动成功后同步修正 record_history.video_file，保证历史记录的打开/播放继续可用
 * - 幂等：已位于批次目录内的文件会被跳过，重复执行不会产生嵌套目录
 */

/** 批次目录名，如 2026年10月7日第二批 */
const BATCH_DIR_RE = /^\d{4}年\d{1,2}月\d{1,2}日第[一二]批$/;

/** 参与归档的视频扩展名（与视频合并工具保持一致） */
const VIDEO_EXTENSIONS = [".ts", ".mp4", ".flv"];

/**
 * 文件名里的录制时间格式，按顺序尝试匹配
 * 1. 中文：前缀_2026年10月7日20点15分0秒.ts
 * 2. 短横线/冒号：2026-10-07 20-30-00-123 标题.ts、2026-10-07_20-30-00.ts、2026-10-07-20-30-00.ts
 * 3. 中文日期 + 短横线时间：2026年10月7日 20-30-00.ts
 * 4. 中文但无秒：2026-10-07 20点30分 标题.ts
 * 分片文件（xxx-PART000.ts）同样能在以上格式中匹配到时间，无需额外处理
 */
const FILE_TIME_PATTERNS: RegExp[] = [
  /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})\s*[点时]\s*(\d{1,2})\s*[分:：]\s*(\d{1,2})\s*[秒s]/,
  /(\d{4})-(\d{1,2})-(\d{1,2})[ _T-]+(\d{1,2})[-:：](\d{1,2})[-:：](\d{1,2})/,
  /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[-:：](\d{1,2})[-:：](\d{1,2})/,
  /(\d{4})-(\d{1,2})-(\d{1,2})[ _T]+(\d{1,2})\s*[点时]\s*(\d{1,2})/,
];

export type TimeBatchArchiveStatus =
  | "ready"
  | "inBatchDir"
  | "unrecognized"
  | "conflict"
  | "recent";

export interface TimeBatchArchiveItem {
  /** 文件绝对路径 */
  path: string;
  /** 文件名 */
  name: string;
  sizeBytes: number;
  /** 从文件名解析出的录制时间（毫秒），解析失败为 null */
  recordTime: number | null;
  /** 归属批次文件夹名，如 2026年10月7日第二批 */
  batchFolder: string | null;
  /** 移动目标绝对路径，未识别/已归类时为 null */
  targetPath: string | null;
  status: TimeBatchArchiveStatus;
  /** 状态说明（跳过的原因等） */
  reason?: string;
}

export interface TimeBatchArchiveOptions {
  inputDir: string;
  recursive?: boolean;
  excludeDirs?: string[];
  /** 最近多少分钟内写入的文件视为「可能正在录制」而跳过，默认 10 分钟 */
  recentMinutes?: number;
}

export interface TimeBatchArchiveResult {
  path: string;
  target?: string;
  batchFolder?: string | null;
  /** 历史记录路径是否已同步修正 */
  historyUpdated?: boolean;
  error?: string;
}

/** 读取全局批次配置；enabled 仅表示录制时是否自动挂目录，归档本身不依赖它 */
function getGlobalTimeBatchConfig() {
  const recorder = appConfig.get("recorder") ?? ({} as Record<string, unknown>);
  return {
    timeBatchEnabled: recorder.timeBatchEnabled ?? false,
    firstStart: (recorder.timeBatchFirstStart as string) || DEFAULT_TIME_BATCH_FIRST_START,
    secondStart: (recorder.timeBatchSecondStart as string) || DEFAULT_TIME_BATCH_SECOND_START,
  };
}

/**
 * 从文件名解析录制时间，解析失败返回 null
 * 已合并成品（只有年月日、没有时分秒）会解析失败，属于预期情况
 */
export function parseRecordTimeFromFileName(fileName: string): number | null {
  const base = path.basename(fileName);
  for (const pattern of FILE_TIME_PATTERNS) {
    const matched = base.match(pattern);
    if (!matched) continue;
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    const hour = Number(matched[4]);
    const minute = Number(matched[5]);
    const second = matched[6] === undefined ? 0 : Number(matched[6]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (hour > 23 || minute > 59 || second > 59) continue;
    const time = new Date(year, month - 1, day, hour, minute, second).getTime();
    if (Number.isNaN(time)) continue;
    return time;
  }
  return null;
}

/** 递归收集视频文件，跳过 excludeDirs 命中的目录名或绝对路径 */
async function walkVideoFiles(
  dir: string,
  recursive: boolean,
  excludeDirs: string[],
  files: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fse.readdir(dir, { withFileTypes: true });
  } catch (error) {
    log.error("scanTimeBatchArchive, read dir error", dir, error);
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const excluded =
        excludeDirs.includes(entry.name) || excludeDirs.includes(path.resolve(fullPath));
      if (recursive && !excluded) await walkVideoFiles(fullPath, recursive, excludeDirs, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    files.push(fullPath);
  }
}

/**
 * 扫描目录，生成归档计划（不移动任何文件）
 */
export async function scanTimeBatchArchive(
  options: TimeBatchArchiveOptions,
): Promise<{ items: TimeBatchArchiveItem[]; timeBatch: { firstStart: string; secondStart: string; enabled: boolean } }> {
  const { inputDir } = options;
  if (!inputDir) throw new Error("输入目录不能为空");
  const resolved = path.resolve(inputDir);
  if (!(await fse.pathExists(resolved))) throw new Error(`输入目录不存在: ${inputDir}`);

  const globalConfig = getGlobalTimeBatchConfig();
  // 归档不依赖录制时的自动挂载开关，边界固定取全局设置
  const batchConfig = {
    enabled: true,
    firstStart: globalConfig.firstStart,
    secondStart: globalConfig.secondStart,
  };
  const timeBatch = {
    firstStart: batchConfig.firstStart,
    secondStart: batchConfig.secondStart,
    enabled: globalConfig.timeBatchEnabled,
  };

  const recursive = options.recursive ?? true;
  const excludeDirs = options.excludeDirs ?? [];
  const recentMinutes = options.recentMinutes ?? 10;
  const recentMs = recentMinutes * 60 * 1000;

  const files: string[] = [];
  await walkVideoFiles(resolved, recursive, excludeDirs, files);

  const items: TimeBatchArchiveItem[] = [];
  for (const file of files) {
    const name = path.basename(file);
    const dir = path.dirname(file);
    const item: TimeBatchArchiveItem = {
      path: file,
      name,
      sizeBytes: 0,
      recordTime: null,
      batchFolder: null,
      targetPath: null,
      status: "ready",
    };

    let mtimeMs = 0;
    try {
      const stat = await fse.stat(file);
      item.sizeBytes = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      log.error("scanTimeBatchArchive, stat file error", file, error);
    }

    // 1. 幂等：已位于批次目录内
    const relativeDir = path.relative(resolved, dir);
    const inBatchDir =
      relativeDir.split(path.sep).filter(Boolean).some((segment) => BATCH_DIR_RE.test(segment)) ||
      BATCH_DIR_RE.test(path.basename(resolved));
    if (inBatchDir) {
      item.status = "inBatchDir";
      item.reason = "已位于批次目录内";
      items.push(item);
      continue;
    }

    // 2. 最近写入：可能正在录制，先跳过避免影响落盘
    if (recentMs > 0 && mtimeMs > 0 && Date.now() - mtimeMs < recentMs) {
      item.status = "recent";
      item.reason = `${recentMinutes} 分钟内写入，可能正在录制`;
      items.push(item);
      continue;
    }

    // 3. 解析录制时间
    const recordTime = parseRecordTimeFromFileName(name);
    if (recordTime == null) {
      item.status = "unrecognized";
      item.reason = "文件名中没有可识别的录制时间（如已合并成品只有年月日）";
      items.push(item);
      continue;
    }
    item.recordTime = recordTime;

    // 4. 判定批次
    const batchInfo = getTimeBatchInfo(new Date(recordTime), batchConfig);
    if (!batchInfo) {
      item.status = "unrecognized";
      item.reason = "批次边界无效（两个时间相同）";
      items.push(item);
      continue;
    }
    item.batchFolder = batchInfo.folderName;

    // 5. 目标路径与冲突检查
    const targetPath = path.join(dir, batchInfo.folderName, name);
    item.targetPath = targetPath;
    if (path.resolve(targetPath) === path.resolve(file)) {
      item.status = "inBatchDir";
      item.reason = "已位于批次目录内";
      continue;
    }
    if (await fse.pathExists(targetPath)) {
      item.status = "conflict";
      item.reason = "目标位置已存在同名文件";
    }

    items.push(item);
  }

  return { items, timeBatch };
}

/**
 * 执行归档：重新扫描后移动「可归档」的文件
 *
 * 注意：不接受前端传入的文件列表，一律由后端按目录重新扫描判定，
 * 避免构造请求移动任意路径的文件。
 */
export async function runTimeBatchArchive(options: TimeBatchArchiveOptions): Promise<{
  results: TimeBatchArchiveResult[];
  timeBatch: { firstStart: string; secondStart: string; enabled: boolean };
}> {
  const { items, timeBatch } = await scanTimeBatchArchive(options);
  const results: TimeBatchArchiveResult[] = [];

  for (const item of items) {
    if (item.status !== "ready" || !item.targetPath) continue;
    const target = item.targetPath;
    try {
      if (!(await fse.pathExists(item.path))) {
        results.push({ path: item.path, error: "源文件已不存在" });
        continue;
      }
      if (await fse.pathExists(target)) {
        results.push({ path: item.path, error: "目标位置已存在同名文件" });
        continue;
      }
      await fse.ensureDir(path.dirname(target));
      await fse.move(item.path, target, { overwrite: false });

      // 同步历史记录里的绝对路径，否则历史记录的打开/播放会失效
      let historyUpdated = false;
      try {
        historyUpdated = updateVideoFilePath(item.path, target);
      } catch (error) {
        log.error("runTimeBatchArchive, update record history path error", item.path, error);
      }

      results.push({
        path: item.path,
        target,
        batchFolder: item.batchFolder,
        historyUpdated,
      });
    } catch (error) {
      log.error("runTimeBatchArchive, move file error", item.path, error);
      results.push({
        path: item.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results, timeBatch };
}
