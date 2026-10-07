<!-- 录制文件按批次日期归档：扫描目录 → 按文件名里的录制时间判定批次 → 移动到批次子目录 -->
<template>
  <div>
    <n-card size="small" :bordered="true" style="margin-bottom: 12px">
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
        <span style="min-width: 72px">归档目录</span>
        <n-input
          v-model:value="inputDir"
          placeholder="要整理的目录，一般是某个主播的录制目录（支持命名：前缀_2026年10月7日20点15分0秒.ts / 2026-10-07 20-30-00 标题.ts）"
          style="flex: 1; min-width: 240px"
          clearable
        />
        <n-button size="small" @click="pickInputDir">选择</n-button>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px">
        <n-checkbox v-model:checked="recursive">包含子目录</n-checkbox>
        <span style="min-width: 96px">跳过最近写入</span>
        <n-input-number v-model:value="recentMinutes" :min="0" :max="1440" style="width: 110px" />
        <span>分钟内的文件</span>
        <n-button type="primary" :loading="scanning" @click="scan">扫描归档计划</n-button>
        <Tip
          tip="按文件名中的录制时间判定批次：第一批 = [第一批起始, 第二批起始) 归属当天，第二批 = [第二批起始, 次日第一批起始) 归属前一天，因此 17 点至次日 6 点录制的文件会归入前一天的第二批目录。批次边界直接读取「设置 → 直播录制 → 批次归类」里的两个时间。<br/>只移动视频文件本身，弹幕（.xml/.ass）与封面（.jpg）留在原目录；已位于批次目录内的文件、目标同名、无法识别时间的文件都不会被移动。<br/>移动后会同步修正历史记录里的文件路径，保证「打开文件 / 播放」继续可用。"
          :size="26"
        ></Tip>
      </div>
      <n-alert v-if="scanned && !timeBatch.enabled" type="warning" :bordered="false" style="margin-top: 8px">
        录制时的「批次归类」开关当前未开启；本工具仍按当前边界
        {{ timeBatch.firstStart }} / {{ timeBatch.secondStart }} 整理历史文件，如需新录制也自动分批请到设置里开启。
      </n-alert>
    </n-card>

    <n-card size="small" :bordered="true" style="margin-bottom: 12px">
      <template #header>
        <div style="display: flex; align-items: center; gap: 10px">
          <span>归档计划</span>
          <span style="font-size: 12px; color: var(--text-3, #999)">{{ summary }}</span>
        </div>
      </template>
      <template #header-extra>
        <div style="display: flex; align-items: center; gap: 8px">
          <n-select v-model:value="statusFilter" size="small" style="width: 150px" :options="filterOptions" />
          <n-button type="primary" :loading="running" :disabled="readyItems.length === 0" @click="run">
            开始归档({{ readyItems.length }})
          </n-button>
        </div>
      </template>

      <n-data-table
        :columns="columns"
        :data="filteredItems"
        :row-key="(row: TimeBatchArchiveItem) => row.path"
        :pagination="false"
        :max-height="460"
        size="small"
      />
      <div v-if="items.length === 0" style="color: #999; text-align: center; padding: 26px 0">
        {{ scanned ? "该目录下没有可识别的视频文件" : "尚未扫描，请先选择目录后点击「扫描归档计划」" }}
      </div>
    </n-card>

    <n-card v-if="results.length > 0" size="small" :bordered="true">
      <template #header>
        <div style="display: flex; align-items: center; gap: 10px">
          <span>执行结果</span>
          <span style="font-size: 12px; color: var(--text-3, #999)">{{ resultSummary }}</span>
        </div>
      </template>
      <n-data-table
        :columns="resultColumns"
        :data="results"
        :row-key="(row: TimeBatchArchiveResult) => row.path"
        :pagination="false"
        :max-height="320"
        size="small"
      />
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { NTag } from "naive-ui";

import Tip from "@renderer/components/Tip.vue";
import { taskApi } from "@renderer/apis";
import type { TimeBatchArchiveItem, TimeBatchArchiveStatus } from "@renderer/apis/task";
import { showDirectoryDialog } from "@renderer/utils/fileSystem";
import { useConfirm } from "@renderer/hooks";

defineOptions({
  name: "TimeBatchArchive",
});

type TimeBatchArchiveResult = {
  path: string;
  target?: string;
  batchFolder?: string | null;
  historyUpdated?: boolean;
  error?: string;
};

const notice = useNotification();
const confirm = useConfirm();

const inputDir = ref("");
const recursive = ref(true);
const recentMinutes = ref(10);
const scanning = ref(false);
const running = ref(false);
const scanned = ref(false);
const items = ref<TimeBatchArchiveItem[]>([]);
const results = ref<TimeBatchArchiveResult[]>([]);
const statusFilter = ref<TimeBatchArchiveStatus | "all">("all");
const timeBatch = ref({ firstStart: "06:00", secondStart: "17:00", enabled: false });

const STATUS_TEXT: Record<TimeBatchArchiveStatus, string> = {
  ready: "可归档",
  inBatchDir: "已在批次目录",
  unrecognized: "无法识别时间",
  conflict: "目标同名",
  recent: "最近写入",
};

const STATUS_TAG_TYPE: Record<TimeBatchArchiveStatus, "success" | "info" | "warning" | "error" | "default"> = {
  ready: "success",
  inBatchDir: "info",
  unrecognized: "warning",
  conflict: "error",
  recent: "default",
};

const filterOptions = [
  { label: "全部", value: "all" },
  ...Object.entries(STATUS_TEXT).map(([value, label]) => ({ label: label as string, value })),
];

const readyItems = computed(() => items.value.filter((item) => item.status === "ready"));

const filteredItems = computed(() =>
  statusFilter.value === "all"
    ? items.value
    : items.value.filter((item) => item.status === statusFilter.value),
);

const summary = computed(() => {
  if (items.value.length === 0) return "";
  const parts = [`共 ${items.value.length} 个文件`, `可归档 ${readyItems.value.length} 个`];
  for (const status of Object.keys(STATUS_TEXT) as TimeBatchArchiveStatus[]) {
    if (status === "ready") continue;
    const count = items.value.filter((item) => item.status === status).length;
    if (count > 0) parts.push(`${STATUS_TEXT[status]} ${count} 个`);
  }
  return parts.join(" / ");
});

const resultSummary = computed(() => {
  const failed = results.value.filter((r) => r.error).length;
  const success = results.value.length - failed;
  const historyFixed = results.value.filter((r) => r.historyUpdated).length;
  return `成功 ${success} 个 / 失败 ${failed} 个${historyFixed > 0 ? `（其中 ${historyFixed} 个已同步历史记录路径）` : ""}`;
});

const formatSize = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatTime = (time: number | null): string => {
  if (time == null) return "-";
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const columns = computed(() => {
  return [
    {
      title: "文件名",
      key: "name",
      render(row: TimeBatchArchiveItem) {
        return h("span", { title: row.path }, row.name);
      },
    },
    {
      title: "识别到的录制时间",
      key: "recordTime",
      width: 170,
      render(row: TimeBatchArchiveItem) {
        return formatTime(row.recordTime);
      },
    },
    {
      title: "归属批次",
      key: "batchFolder",
      width: 190,
      render(row: TimeBatchArchiveItem) {
        if (!row.batchFolder) return "-";
        return h(
          NTag,
          { size: "small", type: "info", bordered: false },
          { default: () => row.batchFolder as string },
        );
      },
    },
    {
      title: "大小",
      key: "sizeBytes",
      width: 100,
      align: "right" as const,
      render(row: TimeBatchArchiveItem) {
        return formatSize(row.sizeBytes);
      },
    },
    {
      title: "状态",
      key: "status",
      width: 190,
      render(row: TimeBatchArchiveItem) {
        return h(
          NTag,
          {
            size: "small",
            type: STATUS_TAG_TYPE[row.status],
            bordered: false,
            title: row.reason,
          },
          { default: () => (row.reason ? `${STATUS_TEXT[row.status]}：${row.reason}` : STATUS_TEXT[row.status]) },
        );
      },
    },
  ];
});

const resultColumns = computed(() => {
  return [
    {
      title: "文件",
      key: "path",
      render(row: TimeBatchArchiveResult) {
        return h("span", { title: row.path }, row.path.split(/[\\/]/).pop() as string);
      },
    },
    {
      title: "目标位置",
      key: "target",
      render(row: TimeBatchArchiveResult) {
        return h("span", { title: row.target }, row.target ?? "-");
      },
    },
    {
      title: "结果",
      key: "error",
      width: 260,
      render(row: TimeBatchArchiveResult) {
        if (row.error) {
          return h(
            NTag,
            { size: "small", type: "error", bordered: false, title: row.error },
            { default: () => row.error as string },
          );
        }
        return h(
          NTag,
          { size: "small", type: "success", bordered: false },
          { default: () => (row.historyUpdated ? "已移动（历史记录已同步）" : "已移动") },
        );
      },
    },
  ];
});

const pickInputDir = async () => {
  const dir: string | undefined = await showDirectoryDialog({ defaultPath: inputDir.value });
  if (dir) inputDir.value = dir;
};

const scan = async () => {
  if (!inputDir.value) {
    notice.error({ title: "请先选择归档目录", duration: 1000 });
    return;
  }
  scanning.value = true;
  results.value = [];
  try {
    const res = await taskApi.scanTimeBatchArchive({
      inputDir: inputDir.value,
      recursive: recursive.value,
      recentMinutes: recentMinutes.value,
    });
    items.value = res.items;
    timeBatch.value = res.timeBatch;
    scanned.value = true;
    if (res.items.length === 0) {
      notice.warning({ title: "没有扫描到视频文件", duration: 2000 });
    } else {
      notice.success({
        title: `扫描完成，共 ${res.items.length} 个文件，可归档 ${readyItems.value.length} 个`,
        duration: 2000,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notice.error({ title: message, duration: 3000 });
  } finally {
    scanning.value = false;
  }
};

const run = async () => {
  if (readyItems.value.length === 0) return;
  const [status] = await confirm.warning({
    title: "确认执行归档？",
    content: `将移动 ${readyItems.value.length} 个文件到对应的批次子目录（文件不会被删除或改名）。批次边界 ${timeBatch.value.firstStart} / ${timeBatch.value.secondStart}，只移动视频文件，弹幕与封面留在原目录。`,
  });
  if (!status) return;

  running.value = true;
  try {
    const res = await taskApi.runTimeBatchArchive({
      inputDir: inputDir.value,
      recursive: recursive.value,
      recentMinutes: recentMinutes.value,
    });
    results.value = res.results;
    const failed = res.results.filter((r) => r.error).length;
    const success = res.results.length - failed;
    if (success > 0) {
      notice.success({ title: `已归档 ${success} 个文件`, duration: 2000 });
    }
    if (failed > 0) {
      notice.error({ title: `${failed} 个文件归档失败，详见执行结果`, duration: 3000 });
    }
    // 重新扫描刷新计划
    const rescan = await taskApi.scanTimeBatchArchive({
      inputDir: inputDir.value,
      recursive: recursive.value,
      recentMinutes: recentMinutes.value,
    });
    items.value = rescan.items;
    timeBatch.value = rescan.timeBatch;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notice.error({ title: message, duration: 3000 });
  } finally {
    running.value = false;
  }
};
</script>
