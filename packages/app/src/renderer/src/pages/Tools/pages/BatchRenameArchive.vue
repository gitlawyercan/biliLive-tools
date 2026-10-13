<!-- 批量修改投稿稿件名称：列表展示名称与分P数，点击名称即可就地编辑，确定后串行 + 随机间隔逐个提交，规避风控 -->
<template>
  <div>
    <n-card size="small" :bordered="true" style="margin-bottom: 12px">
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
        <n-button type="primary" :loading="loading" @click="loadList"> 刷新列表 </n-button>
        <n-button type="primary" :disabled="loading || running" @click="visible = true">
          批量改名并投稿
        </n-button>
        <n-button :disabled="running || editedCount === 0" @click="resetEdits">
          撤销全部修改
        </n-button>
        <span style="font-size: 12px; color: var(--text-3, #999)">
          {{ summary }}
        </span>
        <Tip
          tip="列表来自 B 站创作中心的投稿列表，每行显示稿件名称与分P数量。点击名称即可就地修改，改过的行会显示为待提交状态。<br/>点击「批量改名并投稿」后，后端会按你设定的随机间隔串行逐个提交，每个稿件都是一次独立的改名 + 投稿请求，请求之间自动等待，避免短时间批量操作触发风控。<br/>单个稿件失败不会中断整体流程，失败原因会记录在执行结果里。"
          :size="26"
        ></Tip>
      </div>

      <n-divider style="margin: 10px 0" />

      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
        <n-input
          v-model:value="keyword"
          placeholder="按名称筛选（本地过滤）"
          style="flex: 1; min-width: 220px"
          clearable
        />
        <n-select
          v-model:value="statusFilter"
          size="small"
          style="width: 160px"
          :options="statusOptions"
        />
        <span style="min-width: 130px">提交间隔</span>
        <n-input-number
          v-model:value="minIntervalSec"
          :min="0"
          :max="600"
          size="small"
          style="width: 100px"
        />
        <span>~</span>
        <n-input-number
          v-model:value="maxIntervalSec"
          :min="0"
          :max="1200"
          size="small"
          style="width: 100px"
        />
        <span>秒（随机）</span>
      </div>
    </n-card>

    <n-card size="small" :bordered="true">
      <template #header>
        <div style="display: flex; align-items: center; gap: 10px">
          <span>投稿稿件</span>
          <span style="font-size: 12px; color: var(--text-3, #999)">{{ listSummary }}</span>
        </div>
      </template>

      <n-data-table
        :columns="columns"
        :data="filteredRows"
        :row-key="(row: ArchiveRow) => String(row.aid)"
        :pagination="false"
        :max-height="520"
        size="small"
        :bordered="false"
        :single-line="false"
        class="win11-table"
      />
      <div v-if="rows.length === 0" style="color: #999; text-align: center; padding: 26px 0">
        {{ loading ? "正在加载投稿列表…" : "暂无数据，点击「刷新列表」拉取投稿稿件" }}
      </div>
    </n-card>

    <n-card v-if="results.length > 0" size="small" :bordered="true" style="margin-top: 12px">
      <template #header>
        <div style="display: flex; align-items: center; gap: 10px">
          <span>执行结果</span>
          <span style="font-size: 12px; color: var(--text-3, #999)">{{ resultSummary }}</span>
        </div>
      </template>
      <n-data-table
        :columns="resultColumns"
        :data="results"
        :row-key="(row: BatchRenameArchiveResult) => String(row.aid)"
        :pagination="false"
        :max-height="320"
        size="small"
      />
    </n-card>

    <n-modal
      v-model:show="visible"
      preset="card"
      title="确认提交"
      style="max-width: 520px"
      :mask-closable="!running"
      :closable="!running"
    >
      <div style="display: flex; flex-direction: column; gap: 10px">
        <div>
          将对 <b>{{ editedCount }}</b> 个已修改名称的稿件逐个提交，请求间隔为
          <b>{{ minIntervalSec }}~{{ maxIntervalSec }}</b> 秒随机。
        </div>
        <n-alert type="warning" :bordered="false" size="small">
          预计耗时约 {{ estimatedMinutes }} 分钟。提交期间请勿关闭应用，失败项会在下方结果中列出。
        </n-alert>
        <n-input v-model:value="confirmKeyword" placeholder="输入「确认」以继续" size="small" />
        <n-progress
          v-if="running"
          type="line"
          :percentage="progressPercent"
          :indicator-placement="'inside'"
          :processing="true"
        />
        <div v-if="running" style="font-size: 12px; color: var(--text-3, #999)">
          {{ progressText }}
        </div>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button :disabled="running" @click="visible = false"> 取消 </n-button>
          <n-button
            type="primary"
            :loading="running"
            :disabled="confirmKeyword !== '确认'"
            @click="run"
          >
            开始提交
          </n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { NTag, NText } from "naive-ui";

import Tip from "@renderer/components/Tip.vue";
import { biliApi } from "@renderer/apis";
import { useUserInfoStore } from "@renderer/stores";
import { useConfirm } from "@renderer/hooks";
import type { BatchRenameArchiveResult } from "@renderer/apis/bili";

defineOptions({
  name: "BatchRenameArchive",
});

type ArchiveRow = {
  aid: number;
  bvid: string;
  title: string;
  /** 分P数量 */
  parts: number;
  state: number;
  stateDesc: string;
  cover?: string;
};

const notice = useNotification();
const confirm = useConfirm();
const { userInfo } = storeToRefs(useUserInfoStore());

const rows = ref<ArchiveRow[]>([]);
const loading = ref(false);
const running = ref(false);
const visible = ref(false);
const confirmKeyword = ref("");
const keyword = ref("");
const statusFilter = ref<string>("all");
const minIntervalSec = ref(8);
const maxIntervalSec = ref(20);
const results = ref<BatchRenameArchiveResult[]>([]);
/** aid -> 新标题，只有与原标题不同才算已修改 */
const edits = ref<Record<number, string>>({});
/** 当前正在就地编辑的 aid */
const editingAid = ref<number | null>(null);
const editingValue = ref("");

const statusOptions = [
  { label: "全部状态", value: "all" },
  { label: "审核中", value: "pubing" },
  { label: "已通过", value: "pubed" },
  { label: "未通过", value: "not_pubed" },
];

const editedCount = computed(
  () =>
    Object.keys(edits.value).filter((k) => {
      const aid = Number(k);
      const row = rows.value.find((r) => r.aid === aid);
      return row && edits.value[aid] !== row.title;
    }).length,
);

const filteredRows = computed(() => {
  let list = rows.value;
  if (statusFilter.value !== "all") {
    list = list.filter((r) => stateGroup(r.state) === statusFilter.value);
  }
  const kw = keyword.value.trim().toLowerCase();
  if (kw) {
    list = list.filter((r) => r.title.toLowerCase().includes(kw));
  }
  return list;
});

const summary = computed(() => {
  if (rows.value.length === 0) return "";
  return `共 ${rows.value.length} 个稿件，已修改 ${editedCount.value} 个`;
});

const listSummary = computed(() => {
  if (rows.value.length === 0) return "";
  const parts = [`显示 ${filteredRows.value.length} / ${rows.value.length}`];
  if (editedCount.value > 0) parts.push(`待提交 ${editedCount.value}`);
  return parts.join(" / ");
});

const resultSummary = computed(() => {
  const failed = results.value.filter((r) => !r.success).length;
  return `成功 ${results.value.length - failed} 个 / 失败 ${failed} 个`;
});

/** state -> 粗粒度分组，与 B 站接口的 status 参数语义对齐 */
function stateGroup(state: number): string {
  // 0 = 已通过公开；负值为处理中/未通过
  if (state === 0) return "pubed";
  // -1 待审、-4 被打回等视为未通过
  if (state === -1 || state === -4 || state === -6) return "not_pubed";
  return "pubing";
}

const statusTagType: Record<string, "success" | "warning" | "error" | "default"> = {
  pubed: "success",
  pubing: "warning",
  not_pubed: "error",
};

const estimatedMinutes = computed(() => {
  const n = editedCount.value;
  if (n <= 1) return "0";
  const avg = (minIntervalSec.value + maxIntervalSec.value) / 2;
  const sec = (n - 1) * avg;
  if (sec < 60) return `${Math.ceil(sec)} 秒`;
  return `${(sec / 60).toFixed(1)}`;
});

const progressPercent = computed(() => {
  if (editedCount.value === 0) return 0;
  const done = results.value.length;
  return Math.min(100, Math.round((done / editedCount.value) * 100));
});

const progressText = computed(() => {
  const done = results.value.length;
  const total = editedCount.value;
  const ok = results.value.filter((r) => r.success).length;
  return `已处理 ${done} / ${total}，成功 ${ok}，失败 ${done - ok}`;
});

const loadList = async () => {
  if (!userInfo.value.uid) {
    notice.error({ title: "请先在左侧头像处登录 B 站账号", duration: 2000 });
    return;
  }
  loading.value = true;
  try {
    const res = await biliApi.getArchives(
      { pn: 1, ps: 100, status: "is_pubing,pubed,not_pubed" },
      userInfo.value.uid,
    );
    const list = (res?.arc_audits ?? []).map((item: any) => {
      const archive = item.Archive ?? {};
      const videos = Array.isArray(item.Videos) ? item.Videos : [];
      return {
        aid: Number(archive.aid),
        bvid: archive.bvid ?? "",
        title: archive.title ?? "",
        // 分P数：优先用 Videos 长度，退化时读 Archive.videos
        parts: videos.length || (Array.isArray(archive.videos) ? archive.videos.length : 0),
        state: Number(archive.state ?? 0),
        stateDesc: archive.state_desc ?? "",
        cover: archive.cover,
      } as ArchiveRow;
    });
    rows.value = list;
    // 清掉已不存在稿件的编辑记录
    const aids = new Set(list.map((r) => r.aid));
    const next: Record<number, string> = {};
    for (const k of Object.keys(edits.value)) {
      const aid = Number(k);
      if (aids.has(aid)) next[aid] = edits.value[aid];
    }
    edits.value = next;
    if (list.length === 0) {
      notice.warning({ title: "没有拉取到投稿稿件", duration: 2000 });
    }
  } catch (e) {
    notice.error({ title: e instanceof Error ? e.message : String(e), duration: 3000 });
  } finally {
    loading.value = false;
  }
};

const startEdit = (row: ArchiveRow) => {
  editingAid.value = row.aid;
  editingValue.value = edits.value[row.aid] ?? row.title;
};

const commitEdit = (row: ArchiveRow) => {
  const value = editingValue.value.trim();
  if (value && value !== row.title) {
    edits.value = { ...edits.value, [row.aid]: value };
  } else {
    const next = { ...edits.value };
    delete next[row.aid];
    edits.value = next;
  }
  editingAid.value = null;
};

const cancelEdit = () => {
  editingAid.value = null;
  editingValue.value = "";
};

const resetEdits = () => {
  edits.value = {};
};

const columns = computed(() => [
  {
    title: "名称",
    key: "title",
    // 名称列占满剩余宽度，分P列固定窄列，形似 win11 详细信息视图
    render(row: ArchiveRow) {
      if (editingAid.value === row.aid) {
        return h(NInput, {
          value: editingValue.value,
          size: "small",
          autofocus: true,
          maxlength: 80,
          "show-count": false,
          onUpdateValue: (v: string) => {
            editingValue.value = v;
          },
          onKeyup: (e: KeyboardEvent) => {
            if (e.key === "Enter") commitEdit(row);
            if (e.key === "Escape") cancelEdit();
          },
          onBlur: () => commitEdit(row),
        });
      }
      const edited = edits.value[row.aid];
      const isEdited = !!edited && edited !== row.title;
      return h(
        "div",
        {
          style: "display:flex;align-items:center;gap:8px;cursor:pointer;min-height:24px;",
          title: isEdited ? `原标题：${row.title}` : "点击修改名称",
          onClick: () => startEdit(row),
        },
        [
          h(
            "span",
            {
              style: isEdited
                ? "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d97706;"
                : "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
            },
            edited || row.title,
          ),
          isEdited
            ? h(
                NTag,
                { size: "small", type: "warning", bordered: false },
                { default: () => "已修改" },
              )
            : null,
        ],
      );
    },
  },
  {
    title: "分P",
    key: "parts",
    width: 72,
    align: "right" as const,
    render(row: ArchiveRow) {
      return h("span", { style: "color:var(--text-3,#999);" }, `${row.parts} P`);
    },
  },
  {
    title: "状态",
    key: "state",
    width: 110,
    render(row: ArchiveRow) {
      const group = stateGroup(row.state);
      return h(
        NTag,
        {
          size: "small",
          type: statusTagType[group] ?? "default",
          bordered: false,
          title: row.stateDesc,
        },
        { default: () => row.stateDesc || group },
      );
    },
  },
  {
    title: "稿件ID",
    key: "aid",
    width: 100,
    render(row: ArchiveRow) {
      return h(
        NText,
        { depth: 3, style: "font-size:12px;" },
        { default: () => row.bvid || `av${row.aid}` },
      );
    },
  },
]);

const resultColumns = computed(() => [
  {
    title: "稿件",
    key: "aid",
    width: 110,
    render(row: BatchRenameArchiveResult) {
      return h("span", { style: "font-size:12px;color:var(--text-3,#999);" }, `av${row.aid}`);
    },
  },
  {
    title: "新名称",
    key: "title",
    render(row: BatchRenameArchiveResult) {
      return h("span", { title: row.title }, row.title);
    },
  },
  {
    title: "结果",
    key: "success",
    width: 240,
    render(row: BatchRenameArchiveResult) {
      return h(
        NTag,
        {
          size: "small",
          type: row.success ? "success" : "error",
          bordered: false,
          title: row.error,
        },
        { default: () => (row.success ? "已改名并投稿" : `失败：${row.error}`) },
      );
    },
  },
]);

const run = async () => {
  if (editedCount.value === 0) return;
  const targets = rows.value
    .filter((r) => edits.value[r.aid] && edits.value[r.aid] !== r.title)
    .map((r) => ({
      aid: r.aid,
      bvid: r.bvid,
      title: r.title,
      newTitle: edits.value[r.aid],
    }));

  const [ok] = await confirm.warning({
    title: "确认批量改名并投稿？",
    content: `将串行提交 ${targets.length} 个稿件，随机间隔 ${minIntervalSec.value}~${maxIntervalSec.value} 秒，预计约 ${estimatedMinutes.value} 分钟。`,
  });
  if (!ok) return;

  running.value = true;
  results.value = [];
  try {
    const res = await biliApi.batchRenameArchives(userInfo.value.uid, targets, {
      minIntervalMs: minIntervalSec.value * 1000,
      maxIntervalMs: Math.max(minIntervalSec.value, maxIntervalSec.value) * 1000,
    });
    results.value = res.results ?? [];
    if (res.failed > 0) {
      notice.error({
        title: `成功 ${res.success} 个，失败 ${res.failed} 个，详见执行结果`,
        duration: 4000,
      });
    } else {
      notice.success({ title: `全部 ${res.success} 个稿件已改名并投稿`, duration: 3000 });
    }
    // 提交成功后清空编辑标记并刷新列表
    edits.value = {};
    visible.value = false;
    confirmKeyword.value = "";
    await loadList();
  } catch (e) {
    notice.error({ title: e instanceof Error ? e.message : String(e), duration: 4000 });
  } finally {
    running.value = false;
  }
};

onMounted(() => {
  if (userInfo.value.uid) loadList();
});
</script>

<style scoped>
/* 贴近 win11 详细信息视图：行分隔线清晰、表头淡灰、无纵向重边框 */
.win11-table :deep(.n-data-table-th) {
  background-color: rgba(0, 0, 0, 0.02);
  font-weight: 600;
  color: var(--text-2, #444);
}

.win11-table :deep(.n-data-table-td) {
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.win11-table :deep(.n-data-table-tr:hover .n-data-table-td) {
  background-color: rgba(0, 0, 0, 0.035);
}
</style>
