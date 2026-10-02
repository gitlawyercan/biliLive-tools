import path from "node:path";

import type { Dirent } from "node:fs";

import fse from "fs-extra";

import log from "../utils/log.js";

/**
 * 视频分组扫描
 *
 * 参照 v2 合并项目（merger_core.py）移植的分组逻辑：
 * - 录制文件命名：{前缀}_{年}年{月}月{日}日{时}点{分}分{秒}秒.扩展名
 * - 按「前缀_日期」分组（日期去前导零归一，2026年09月07日 等同 2026年9月7日）
 * - 组内按录制时间升序；组间日期倒序、同日期按前缀升序
 * - 已合并成品（前缀_合并.扩展名 或 前缀_日期.扩展名）识别为成品组，排在最后
 * - 不包含任何时间戳跳变修复（重编码）逻辑，合并固定使用 -c copy
 */

/** 参与扫描的视频扩展名 */
export const VIDEO_EXTENSIONS = [".ts", ".mp4", ".flv"];

/** 录制文件：前缀_2026年9月28日10点00分00秒.ts（严格包含时分秒） */
export const VIDEO_PATTERN = /^(.+)_(\d{4}年\d{1,2}月\d{1,2}日\d{1,2}点\d{1,2}分\d{1,2}秒)\.\w+$/u;

/** 成品文件：前缀_合并.ts，或 前缀_2026年9月28日.ts（日期后不跟时分秒） */
export const FINISHED_PATTERN = /^(.+?)_(?:合并|(?:\d{4}年\d{1,2}月\d{1,2}日(?!\d{1,2}点)))\.\w+$/u;

/** emoji 及变体选择符、零宽连接符 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/** 输出目录默认排除名（与 v2 一致，避免把已合并成品再次扫入） */
export const DEFAULT_EXCLUDE_DIR_NAMES = ["merge"];

/** 日期字符串归一：去前导零，2026年09月07日 -> 2026年9月7日 */
export function normalizeDate(dateStr: string): string {
  return dateStr.replace(/年0(\d{1,2})月/g, "年$1月").replace(/月0(\d{1,2})日/g, "月$1日");
}

/** 解析录制时间字符串为毫秒时间戳，解析失败返回 0 */
export function parseVideoDate(dateStr: string): number {
  const m = dateStr.match(
    /(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})点(\d{1,2})分(\d{1,2})秒/,
  );
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** 从分组名中解析日期部分（前缀_2026年9月28日），无日期返回 0 */
function parseGroupDate(groupName: string): number {
  const m = groupName.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

export interface VideoGroupFile {
  /** 文件绝对路径 */
  path: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 录制时间戳（毫秒），成品文件为 0 */
  timestamp: number;
}

export interface VideoGroup {
  /** 分组名，如 张三_2026年9月28日、张三_合并 */
  name: string;
  /** 净化后的输出文件名主干（剔除 emoji、非法字符替换），与合并输出一致 */
  outputName: string;
  /** 是否为已合并成品组 */
  isFinished: boolean;
  files: VideoGroupFile[];
  count: number;
  sizeBytes: number;
}

export interface ScanVideoGroupsOptions {
  /** 是否递归扫描子目录，默认 true */
  recursive?: boolean;
  /** 排除的目录：传入目录名或绝对路径均可 */
  excludeDirs?: string[];
}

/** 递归收集目录下的文件（跳过 excludeDirs 命中的目录名或路径） */
async function walkDir(
  dir: string,
  recursive: boolean,
  excludeDirs: string[],
  files: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fse.readdir(dir, { withFileTypes: true });
  } catch (error) {
    log.error("scanVideoGroups, read dir error", dir, error);
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const excluded =
        excludeDirs.includes(entry.name) || excludeDirs.includes(path.resolve(fullPath));
      if (recursive && !excluded) {
        await walkDir(fullPath, recursive, excludeDirs, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    files.push(fullPath);
  }
}

/**
 * 扫描目录并按「前缀_日期」分组
 * @param inputDir 输入目录
 * @param options 扫描选项
 */
export async function scanVideoGroups(
  inputDir: string,
  options: ScanVideoGroupsOptions = {},
): Promise<VideoGroup[]> {
  const recursive = options.recursive ?? true;
  const excludeDirs = [...DEFAULT_EXCLUDE_DIR_NAMES, ...(options.excludeDirs ?? [])];

  if (!(await fse.pathExists(inputDir))) {
    throw new Error(`输入目录不存在: ${inputDir}`);
  }

  const files: string[] = [];
  await walkDir(path.resolve(inputDir), recursive, excludeDirs, files);

  interface TmpGroup {
    name: string;
    isFinished: boolean;
    files: VideoGroupFile[];
  }
  const groupMap = new Map<string, TmpGroup>();

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const videoMatch = fileName.match(VIDEO_PATTERN);
    if (videoMatch) {
      const prefix = videoMatch[1];
      // 分组键只取日期部分（归组按「前缀_日期」，同日不同时段的分段合为一组），与 v2 _norm_date 行为一致
      const dateOnly = videoMatch[2].match(/\d{4}年\d{1,2}月\d{1,2}日/)![0];
      const datePart = normalizeDate(dateOnly);
      const key = `${prefix}_${datePart}`;
      let group = groupMap.get(key);
      if (!group) {
        group = { name: key, isFinished: false, files: [] };
        groupMap.set(key, group);
      }
      group.files.push({ path: filePath, name: fileName, timestamp: parseVideoDate(videoMatch[2]) });
      continue;
    }
    const finishedMatch = fileName.match(FINISHED_PATTERN);
    if (finishedMatch) {
      // 成品文件名即分组名，一组一个文件
      const key = path.parse(fileName).name;
      if (!groupMap.has(key)) {
        groupMap.set(key, { name: key, isFinished: true, files: [] });
      }
      groupMap.get(key)!.files.push({ path: filePath, name: fileName, timestamp: 0 });
    }
    // 两种命名都不匹配的文件忽略
  }

  const groups = [...groupMap.values()];

  // 组内按录制时间升序
  for (const group of groups) {
    group.files.sort((a, b) => a.timestamp - b.timestamp || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // 组间排序：成品最后 -> 日期倒序 -> 前缀升序
  groups.sort((a, b) => {
    if (a.isFinished !== b.isFinished) return a.isFinished ? 1 : -1;
    const dateA = parseGroupDate(a.name);
    const dateB = parseGroupDate(b.name);
    if (dateA !== dateB) return dateB - dateA;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // 补充统计信息
  return await Promise.all(
    groups.map(async (group) => {
      let sizeBytes = 0;
      for (const file of group.files) {
        try {
          const stat = await fse.stat(file.path);
          sizeBytes += stat.size;
        } catch (error) {
          log.error("scanVideoGroups, stat file error", file.path, error);
        }
      }
      return {
        name: group.name,
        outputName: buildOutputBase(group.name),
        isFinished: group.isFinished,
        files: group.files,
        count: group.files.length,
        sizeBytes,
      };
    }),
  );
}

/**
 * 生成分组合并的输出文件名主干
 * - 剔除 emoji，非法文件名字符替换为 _
 * - autoPrefix 自动补全角冒号「：」，如 萌妹精选 + 张三_2026年9月28日 -> 萌妹精选：张三_2026年9月28日
 */
export function buildOutputBase(groupName: string, autoPrefix = ""): string {
  let base = groupName.replace(EMOJI_RE, "").replace(/[<>:"/\\|?*]/g, "_").trim();
  if (!base) {
    base = "未命名";
  }
  if (autoPrefix) {
    const prefix = autoPrefix.endsWith("：") || autoPrefix.endsWith(":") ? autoPrefix : `${autoPrefix}：`;
    base = `${prefix}${base}`;
  }
  return base;
}
