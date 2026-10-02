<!-- 文件合并（按目录扫描分组模式，参照 v2 合并项目） -->
<template>
  <div>
    <n-card size="small" :bordered="true" style="margin-bottom: 12px">
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
        <span style="min-width: 64px">输入目录</span>
        <n-input
          v-model:value="inputDir"
          placeholder="录制文件所在目录，命名格式：前缀_2026年9月28日10点00分00秒.ts"
          style="flex: 1; min-width: 240px"
          clearable
        />
        <n-button size="small" @click="pickInputDir">选择</n-button>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px">
        <span style="min-width: 64px">输出目录</span>
        <n-input
          v-model:value="outputDir"
          placeholder="默认保存到输入目录"
          style="flex: 1; min-width: 240px"
          clearable
        />
        <n-button size="small" @click="pickOutputDir">选择</n-button>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px">
        <span style="min-width: 64px">补前缀</span>
        <n-input
          v-model:value="autoPrefix"
          placeholder="可选，输出文件名前自动添加，如：萌妹精选 → 萌妹精选：张三_2026年9月28日.ts"
          style="flex: 1; min-width: 240px"
          clearable
        />
        <n-checkbox v-model:checked="removeOrigin">
          合并成功后移除源文件
        </n-checkbox>
        <n-button type="primary" :loading="scanning" @click="scan">扫描文件</n-button>
        <Tip
          tip="按「前缀_日期」将录制文件自动分组（同一人同一天为一组），组内无损合并为 {分组名}.ts；单个文件的分组将直接移动到输出目录并按合并后名称重命名。使用 -c copy 无损合并，不含修复时间戳跳变功能。"
          :size="26"
        ></Tip>
      </div>
    </n-card>

    <n-card size="small" :bordered="true">
      <template #header>
        <div style="display: flex; align-items: center; gap: 10px">
          <span>视频分组</span>
          <span style="font-size: 12px; color: var(--text-3, #999)">{{ summary }}</span>
        </div>
      </template>
      <template #header-extra>
        <ButtonGroup
          v-if="groups.length > 0"
          :options="buttonGroupOptions"
          @click="handleTableAction"
          title="分组操作"
          >分组操作</ButtonGroup
        >
        <n-button
          type="primary"
          style="margin-left: 8px"
          :disabled="selectedGroups.length === 0"
          @click="handleMerge"
          >立即合并(ctrl+enter)</n-button
        >
      </template>

      <n-data-table
        :columns="columns"
        :data="groups"
        :row-key="(row: VideoGroup) => row.name"
        :checked-row-keys="checkedRowNames"
        @update:checked-row-keys="handleCheckedChange"
        :pagination="false"
        :max-height="480"
        size="small"
      />
      <div v-if="groups.length === 0" style="color: #999; text-align: center; padding: 26px 0">
        尚未扫描，请先选择输入目录后点击「扫描文件」
      </div>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { NButton, NTag } from "naive-ui";
import hotkeys from "hotkeys-js";

import Tip from "@renderer/components/Tip.vue";
import ButtonGroup from "@renderer/components/ButtonGroup.vue";
import { taskApi } from "@renderer/apis";
import type { VideoGroup } from "@renderer/apis/task";
import { showDirectoryDialog } from "@renderer/utils/fileSystem";
import { useConfirm } from "@renderer/hooks";

defineOptions({
  name: "VideoMerge",
});

const notice = useNotification();
const confirm = useConfirm();

const inputDir = ref("");
const outputDir = ref("");
const autoPrefix = ref("");
const removeOrigin = ref(false);
const scanning = ref(false);
const groups = ref<VideoGroup[]>([]);
const checkedRowNames = ref<string[]>([]);

const buttonGroupOptions = computed(() => {
  return [
    {
      key: "selectAll",
      label: "全选",
    },
    {
      key: "deselectAll",
      label: "取消全选",
    },
  ];
});

const selectableGroups = computed(() => groups.value.filter((g) => !g.isFinished));

const selectedGroups = computed(() => {
  return selectableGroups.value.filter((g) => checkedRowNames.value.includes(g.name));
});

const summary = computed(() => {
  if (groups.value.length === 0) return "";
  const totalFiles = groups.value.reduce((acc, g) => acc + g.count, 0);
  return `${groups.value.length} 个分组 / ${totalFiles} 个文件，已选 ${selectedGroups.value.length} 组`;
});

const formatSize = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** 分组显示名：以合并后的文件名为准（含补前缀预览） */
const outputDisplayName = (row: VideoGroup): string => {
  const prefix = autoPrefix.value.trim();
  if (!prefix) return row.outputName;
  const full = prefix.endsWith("：") || prefix.endsWith(":") ? prefix : `${prefix}：`;
  return `${full}${row.outputName}`;
};

const columns = computed(() => {
  return [
    {
      type: "selection" as const,
      disabled: (row: VideoGroup) => row.isFinished,
    },
    {
      title: "合并后名称（前缀_日期）",
      key: "name",
      render(row: VideoGroup) {
        const displayName = outputDisplayName(row);
        const differs = displayName !== row.name;
        return h("div", { style: "display:flex;align-items:center;gap:6px" }, [
          h(
            "span",
            { title: differs ? `原始分组名：${row.name}` : undefined },
            displayName,
          ),
          row.isFinished
            ? h(
                NTag,
                { size: "small", type: "info", bordered: false },
                { default: () => "成品" },
              )
            : null,
          row.count === 1 && !row.isFinished
            ? h(
                NTag,
                { size: "small", type: "success", bordered: false },
                { default: () => "单文件·重命名" },
              )
            : null,
        ]);
      },
    },
    {
      title: "文件数",
      key: "count",
      width: 90,
      align: "center" as const,
    },
    {
      title: "总大小",
      key: "sizeBytes",
      width: 120,
      align: "right" as const,
      render(row: VideoGroup) {
        return formatSize(row.sizeBytes);
      },
    },
    {
      title: "操作",
      key: "actions",
      width: 90,
      render(row: VideoGroup) {
        return h(
          NButton,
          {
            size: "tiny",
            onClick: () => viewGroupFiles(row),
          },
          { default: () => "查看" },
        );
      },
    },
  ];
});

const pickInputDir = async () => {
  const dir = await showDirectoryDialog({ defaultPath: inputDir.value || undefined });
  if (dir) {
    inputDir.value = dir;
    // 输出目录为空时默认跟随输入目录
    if (!outputDir.value) outputDir.value = dir;
  }
};

const pickOutputDir = async () => {
  const dir = await showDirectoryDialog({ defaultPath: outputDir.value || inputDir.value || undefined });
  if (dir) outputDir.value = dir;
};

const scan = async () => {
  if (!inputDir.value) {
    notice.error({ title: "请先选择输入目录", duration: 1000 });
    return;
  }
  scanning.value = true;
  checkedRowNames.value = [];
  try {
    const res = await taskApi.scanVideoGroups(inputDir.value, {
      recursive: true,
      excludeDirs: outputDir.value ? [outputDir.value] : [],
    });
    groups.value = res.groups;
    // 默认全选可合并分组
    checkedRowNames.value = selectableGroups.value.map((g) => g.name);
    notice.success({ title: `扫描完成，共 ${res.groups.length} 个分组`, duration: 1000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notice.error({
      title: message,
      duration: 3000,
    });
  } finally {
    scanning.value = false;
  }
};

const handleCheckedChange = (keys: Array<string | number>) => {
  checkedRowNames.value = keys as string[];
};

const handleTableAction = (key?: string | number) => {
  if (key === "selectAll") {
    checkedRowNames.value = selectableGroups.value.map((g) => g.name);
  } else if (key === "deselectAll") {
    checkedRowNames.value = [];
  }
};

const viewGroupFiles = (row: VideoGroup) => {
  const list = row.files.map((f) => f.name).join("\n");
  useDialog().info({
    title: `分组：${row.name}（${row.count} 个文件）`,
    content: list,
  });
};

const handleMerge = async () => {
  const selected = selectedGroups.value;
  if (selected.length === 0) {
    notice.error({ title: "请先勾选要合并的分组", duration: 1000 });
    return;
  }

  // 合并前一致性检查（编码/分辨率/采样率），只提示不阻断；单文件分组跳过检查（直接重命名移动）
  const problemLines: string[] = [];
  for (const group of selected) {
    if (group.count < 2) continue;
    try {
      const result = await taskApi.checkMergeVideos(group.files.map((f) => f.path));
      const issues = [...result.errors, ...result.warnings];
      if (issues.length > 0) {
        problemLines.push(`【${group.name}】${issues.join("；")}`);
      }
    } catch (error) {
      console.warn("checkMergeVideos failed", group.name, error);
    }
  }
  if (problemLines.length > 0) {
    const [status] = await confirm.warning({
      title: "部分分组参数不一致，合并很可能出现问题，是否继续？",
      content: problemLines.join("\n"),
    });
    if (!status) return;
  }

  const realOutputDir = outputDir.value || inputDir.value;
  try {
    const res = await taskApi.mergeVideoGroups({
      groups: selected.map((g) => ({ name: g.name, files: g.files.map((f) => f.path) })),
      outputDir: realOutputDir,
      autoPrefix: autoPrefix.value.trim(),
      removeOrigin: removeOrigin.value,
    });
    const failed = res.results.filter((r) => r.error);
    const success = res.results.length - failed.length;
    if (success > 0) {
      notice.success({
        title: removeOrigin.value
          ? `已提交 ${success} 个任务（合并成功后源文件将进回收站）`
          : `已提交 ${success} 个任务，可在任务队列中查看进度`,
        duration: 2000,
      });
    }
    for (const item of failed) {
      notice.error({ title: `${item.name}：${item.error}`, duration: 3000 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notice.error({
      title: message,
      duration: 3000,
    });
  }
};

onActivated(() => {
  hotkeys("ctrl+enter", function () {
    handleMerge();
  });
});
onDeactivated(() => {
  hotkeys.unbind();
});
onUnmounted(() => {
  hotkeys.unbind();
});
</script>

<style scoped lang="less"></style>
