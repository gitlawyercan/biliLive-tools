/**
 * 抖音单场录制时长上限
 *
 * 需求：为每个抖音直播间单独设置「每场直播最多录多少小时」。
 *
 * 设计要点：
 * 1. 额度按「实际录制时长」累计，断流、重连的空闲时间不计入。
 *    之所以不用墙钟：抖音的 liveStartTime 是 new Date() 伪造的（见 stream.ts
 *    的 getInfo），每次调用都在变，无法作为本场起点。
 * 2. 场次边界由 liveId 判定 —— 换场次或下播即重置额度。
 * 3. 手动开始录制视为用户明确意图，重新授予完整额度。
 * 4. 额度用尽后本场不再录制。为避免空转请求，探测间隔放宽到
 *    PROBE_MIN_INTERVAL_MS；一旦探测到下播，状态被清除、闸门自动失效，
 *    检测间隔随即恢复到全局配置。
 * 5. 额度落盘持久化（douyin-quota-state.json，与 appConfig.json 同目录）：
 *    进程/容器意外重启后，内存额度丢失会导致同场次「满血重录」超出场次上限。
 *    现按录制周期写盘（段开始、录制中每 QUOTA_FLUSH_INTERVAL_MS、段结束），
 *    重启后同 liveId 恢复已录时长、只录剩余时间；换场次/下播/手动开始时清除。
 *    崩溃前最后不足一个写盘周期的时间可能未落盘，恢复后至多多录约 1 分钟。
 */

import fs from "node:fs";
import path from "node:path";

import { appConfig } from "@biliLive-tools/shared/config.js";

/** 停止原因，会出现在时间线与录制历史中 */
export const LIMIT_STOP_REASON = "达到单场录制时长上限";

/**
 * 额度用尽后的探测间隔。
 *
 * 这段时间里主播还在播、但本场不会再录，若仍按全局间隔（抖音默认 60 秒）
 * 发请求会造成大量空转。放宽到 10 分钟可把 6 小时封锁窗口的请求量
 * 从约 360 次压到约 36 次。
 *
 * 注意这不是永久降频：探测到 living === false 后额度状态会被删除，
 * isExhausted 随即返回 false，本闸门不再生效，检测间隔回到全局配置。
 */
const PROBE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** 额度写盘周期：录制中每隔该时长把累计已录时长刷入磁盘 */
const QUOTA_FLUSH_INTERVAL_MS = 60 * 1000;

interface QuotaState {
  /** 本场场次标识，用于判定是否换场 */
  liveId: string;
  /** 已累计的实际录制时长（毫秒），不含断流空闲 */
  recordedMs: number;
  /** 当前录制段的起点，未在录制时为 null */
  segmentStartAt: number | null;
  /** 到点自动停止的定时器 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 定时器归属的 recordHandle.id，防止旧定时器误停新段 */
  timerOwnerHandleId: string | null;
  /** 周期性写盘定时器 */
  flushTimer: ReturnType<typeof setInterval> | null;
}

/** recorderId -> 本场额度状态 */
const states = new Map<string, QuotaState>();
/** recorderId -> 上次真正发起探测的时刻 */
const lastProbeAt = new Map<string, number>();

type QuotaRecorder = {
  id: string;
  douyinMaxRecordHours?: number;
};

// ---------------------------------------------------------------------------
// 额度持久化：与 appConfig.json 同目录的 douyin-quota-state.json
// ---------------------------------------------------------------------------

interface PersistedEntry {
  liveId: string;
  recordedMs: number;
  updatedAt: number;
}

/** recorderId -> 落盘的额度记录 */
const persisted = new Map<string, PersistedEntry>();
let storeLoaded = false;

/** 存储文件路径；appConfig 未初始化（拿不到目录）时返回 null，持久化自动禁用 */
function storeFilepath(): string | null {
  const configPath = appConfig.filepath;
  if (!configPath) return null;
  return path.join(path.dirname(configPath), "douyin-quota-state.json");
}

/** 惰性加载磁盘额度记录；文件缺失或损坏时按无历史处理（等同旧版满额行为） */
function loadStore(): void {
  if (storeLoaded) return;
  storeLoaded = true;
  const fp = storeFilepath();
  if (!fp || !fs.existsSync(fp)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (raw && typeof raw === "object") {
      for (const [id, entry] of Object.entries<any>(raw)) {
        if (
          entry &&
          typeof entry.liveId === "string" &&
          Number.isFinite(entry.recordedMs) &&
          entry.recordedMs > 0
        ) {
          persisted.set(id, {
            liveId: entry.liveId,
            recordedMs: entry.recordedMs,
            updatedAt: Number(entry.updatedAt) || 0,
          });
        }
      }
    }
  } catch (error) {
    console.warn(`[DouYin][maxDuration] 额度持久化文件读取失败，按无历史处理:`, error);
  }
}

/** 原子写盘（临时文件 + rename），失败只告警不影响内存额度 */
function writeStore(): void {
  const fp = storeFilepath();
  if (!fp) return;
  try {
    const obj: Record<string, PersistedEntry> = {};
    for (const [id, entry] of persisted) obj[id] = entry;
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, fp);
  } catch (error) {
    console.warn(`[DouYin][maxDuration] 额度持久化写盘失败:`, error);
  }
}

/** 当前段运行时间并入已录时长的快照（写盘用，崩溃时最多丢失一个写盘周期） */
function snapshotRecordedMs(state: QuotaState): number {
  return state.recordedMs + (state.segmentStartAt != null ? Date.now() - state.segmentStartAt : 0);
}

/** 把某录制器的当前额度刷入磁盘 */
function flushPersisted(recorderId: string, state: QuotaState): void {
  if (!state.liveId) return;
  loadStore();
  persisted.set(recorderId, {
    liveId: state.liveId,
    recordedMs: snapshotRecordedMs(state),
    updatedAt: Date.now(),
  });
  writeStore();
}

/** 删除某录制器的落盘记录（手动开始 / 下播 / 换场次时调用） */
function removePersisted(recorderId: string): void {
  loadStore();
  if (persisted.delete(recorderId)) writeStore();
}

/** 把限制配置的「小时」换算成毫秒上限；小于等于 0 或非法值表示不限制 */
export function getLimitMs(recorder: QuotaRecorder): number {
  const hours = Number(recorder.douyinMaxRecordHours);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * 60 * 60 * 1000;
}

function clearTimer(state: QuotaState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.timerOwnerHandleId = null;
}

function clearFlushTimer(state: QuotaState): void {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
}

function resetState(recorderId: string, liveId: string): QuotaState {
  const state: QuotaState = {
    liveId,
    recordedMs: 0,
    segmentStartAt: null,
    timer: null,
    timerOwnerHandleId: null,
    flushTimer: null,
  };
  states.set(recorderId, state);
  return state;
}

/** 本场已累计的实际录制时长（毫秒） */
export function getRecordedMs(recorderId: string): number {
  return states.get(recorderId)?.recordedMs ?? 0;
}

/** 本场额度是否已用尽。未配置上限时恒为 false */
export function isExhausted(recorder: QuotaRecorder): boolean {
  const limitMs = getLimitMs(recorder);
  if (limitMs <= 0) return false;
  return getRecordedMs(recorder.id) >= limitMs;
}

/**
 * 降频闸门：额度用尽后，是否到了该真正发一次探测请求的时刻。
 *
 * 探测到 living === false 后额度状态会被删除，isExhausted 随即为 false，
 * 本函数自然不再被调用 —— 降频自动解除、恢复全局检查间隔。
 */
export function shouldProbeNow(recorderId: string): boolean {
  const last = lastProbeAt.get(recorderId) ?? 0;
  if (Date.now() - last >= PROBE_MIN_INTERVAL_MS) {
    lastProbeAt.set(recorderId, Date.now());
    return true;
  }
  return false;
}

/**
 * 场次边界同步。每次拿到最新场次信息后调用。
 *
 * - 手动开始：重新授予完整额度（并清除落盘记录）
 * - 下播：清空状态（额度、降频、落盘一并复位）
 * - 在播但内存无状态：进程/容器重启场景 —— 同场次从磁盘恢复已录时长，
 *   只录剩余时间；不同场次则重置额度
 * - 在播且换场次：重置额度
 */
export function syncSession(args: {
  recorderId: string;
  liveId: string;
  living: boolean;
  isManualStart?: boolean;
}): void {
  const { recorderId, liveId, living, isManualStart } = args;
  const current = states.get(recorderId);

  // 1. 手动开始：用户明确要求录，重新授予额度
  if (isManualStart) {
    if (current) {
      clearTimer(current);
      current.recordedMs = 0;
      current.segmentStartAt = null;
      if (liveId) current.liveId = liveId;
    } else {
      resetState(recorderId, liveId);
    }
    lastProbeAt.delete(recorderId);
    removePersisted(recorderId);
    return;
  }

  // 2. 下播：本场结束。清空后 isExhausted 返回 false，
  //    降频闸门随之失效，检测间隔立即回到全局配置。
  if (!living) {
    clearRecorder(recorderId);
    return;
  }

  // 3. 在播但内存无状态：进程/容器重启后首次检查到本场次。
  //    落盘记录的 liveId 与当前一致 → 恢复已录时长，只录剩余时间。
  if (!current) {
    loadStore();
    const saved = persisted.get(recorderId);
    if (saved && liveId && saved.liveId === liveId && saved.recordedMs > 0) {
      const restored = resetState(recorderId, liveId);
      restored.recordedMs = saved.recordedMs;
    } else {
      resetState(recorderId, liveId);
    }
    return;
  }

  // 4. 在播且换场次：重置额度（旧场次的落盘记录一并清除）
  if (liveId && current.liveId !== liveId) {
    clearTimer(current);
    clearFlushTimer(current);
    removePersisted(recorderId);
    resetState(recorderId, liveId);
  }
}

/**
 * 录制段开始：记录本段起点，按剩余额度装一个精确停止定时器，
 * 并启动周期写盘（崩溃后可从最近一次快照恢复）。
 *
 * 定时器负责准点停止（毫秒级），checkLiveStatusAndRecord 里的兜底检查
 * 用于应对定时器被系统挂起或节流的情况。
 */
export function onSegmentStart(
  recorder: QuotaRecorder & {
    recordHandle?: { id: string; stop: (reason?: string) => Promise<void> } | null;
  },
): void {
  const limitMs = getLimitMs(recorder);
  if (limitMs <= 0) return;

  let state = states.get(recorder.id);
  if (!state) state = resetState(recorder.id, "");

  state.segmentStartAt = Date.now();

  const handleId = recorder.recordHandle?.id;
  if (!handleId) return;

  // 上一段的定时器已经无用，先清掉
  clearTimer(state);

  const remaining = limitMs - state.recordedMs;
  if (remaining <= 0) {
    void recorder.recordHandle?.stop(LIMIT_STOP_REASON);
    return;
  }

  state.timerOwnerHandleId = handleId;
  const timer = setTimeout(() => {
    const latest = states.get(recorder.id);
    // 状态已被清掉（换场 / 下播），或定时器已不属于当前段
    if (!latest || latest.timerOwnerHandleId !== handleId) return;
    latest.timer = null;
    latest.timerOwnerHandleId = null;
    void recorder.recordHandle?.stop(LIMIT_STOP_REASON);
  }, remaining);

  // Node 环境下避免这个定时器拖住进程退出；其他环境无此方法
  (timer as { unref?: () => void }).unref?.();

  state.timer = timer;

  // 周期写盘：把「已录累计 + 当前段运行时间」的快照刷入磁盘。
  // 只在定时器仍属于当前段时刷新，防止旧段的定时器污染新段。
  clearFlushTimer(state);
  flushPersisted(recorder.id, state);
  const flushTimer = setInterval(() => {
    const latest = states.get(recorder.id);
    if (!latest || latest.timerOwnerHandleId !== handleId) return;
    flushPersisted(recorder.id, latest);
  }, QUOTA_FLUSH_INTERVAL_MS);
  (flushTimer as { unref?: () => void }).unref?.();
  state.flushTimer = flushTimer;
}

/** 录制段结束：把本段实际时长累加进额度，并精确写盘 */
export function onSegmentEnd(recorder: { id: string }): void {
  const state = states.get(recorder.id);
  if (!state) return;

  if (state.segmentStartAt != null) {
    state.recordedMs += Date.now() - state.segmentStartAt;
    state.segmentStartAt = null;
  }
  clearTimer(state);
  clearFlushTimer(state);
  flushPersisted(recorder.id, state);
}

/** 清空某个录制器的全部额度状态（移除录制器、下播时调用），含落盘记录 */
export function clearRecorder(recorderId: string): void {
  const state = states.get(recorderId);
  if (state) {
    clearTimer(state);
    clearFlushTimer(state);
  }
  states.delete(recorderId);
  lastProbeAt.delete(recorderId);
  removePersisted(recorderId);
}
