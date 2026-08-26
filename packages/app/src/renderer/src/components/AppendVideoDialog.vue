<template>
  <n-modal v-model:show="showModal" :mask-closable="false" auto-focus :on-after-enter="handleOpen">
    <n-card
      style="max-height: 80%"
      :bordered="false"
      role="dialog"
      aria-modal="true"
      class="card"
      :style="{
        width: isMobile ? '100%' : 'calc(100% - 60px)',
      }"
    >
      <div>
        <p>续传只会增加分p，不会对稿件进行编辑</p>
        <div class="haeder" style="display: flex; gap: 10px; align-items: center">
          <n-pagination
            v-model:page="page"
            :page-count="pageCount"
            show-quick-jumper
            :size="isMobile ? 'small' : 'medium'"
            :page-slot="isMobile ? 6 : 9"
          />

          <n-button style="margin-left: auto" class="btn" @click="close">取消</n-button>
          <n-button type="primary" class="btn" @click="confirm"> 确认 </n-button>
        </div>
        <div class="media-container">
          <div
            v-for="item in list"
            :key="item.Archive.aid"
            class="media"
            :class="{ selected: aid == item.Archive.aid }"
            @click="selectMedia(item)"
          >
            <div class="cover-wrapper">
              <img :src="item.Archive.cover" referrerpolicy="no-referrer" class="cover" />
              <span v-if="getPartCount(item) !== undefined" class="part-count">{{ getPartCount(item) }}P</span>
            </div>
            <div class="title">{{ item.Archive.title }}</div>
          </div>
        </div>
      </div>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { useAppConfig } from "@renderer/stores";
import { biliApi } from "@renderer/apis";
import { useBreakpoints } from "@renderer/hooks";

const { appConfig } = storeToRefs(useAppConfig());

const showModal = defineModel<boolean>("visible", { required: true, default: false });
const aid = defineModel<string>({ required: false });
const emits = defineEmits<{
  confirm: [aid: string];
}>();
const notice = useNotification();
const { isMobile } = useBreakpoints();

const list = ref<
  {
    stat: {
      aid: number;
      [key: string]: any;
    };
    Archive: {
      title: string;
      cover: string;
      [key: string]: any;
    };
    /** 分P数量，异步获取 */
    partCount?: number;
    [key: string]: any;
  }[]
>([]);

const page = ref(1);
const pageCount = ref(1);

watch(
  () => page.value,
  () => {
    getArchives();
  },
);

const getArchives = async () => {
  const uid = appConfig.value.uid;
  if (!uid) {
    notice.warning({
      title: "请先登录",
      duration: 500,
    });
    return;
  }
  const data = await biliApi.getArchives(
    {
      pn: page.value,
      ps: 20,
    },
    uid,
  );
  pageCount.value = Math.ceil(data.page.count / data.page.ps);

  list.value = data.arc_audits;
};
const handleOpen = () => {
  getArchives();
};
const close = () => {
  aid.value = "";
  showModal.value = false;
};

const confirm = async () => {
  if (!aid.value) {
    return;
  }
  emits("confirm", aid.value);
  showModal.value = false;
};

const selectMedia = async (item) => {
  aid.value = String(item.Archive.aid);

  // 选中时才请求分P数
  const uid = appConfig.value.uid;
  if (!uid) return;
  try {
    const detail = await biliApi.getArchiveDetail(item.Archive.bvid, uid);
    item.partCount = detail.View?.pages?.length ?? 1;
  } catch {
    item.partCount = 1;
  }
};

/**
 * 获取稿件分P数（仅选中后有值）
 */
const getPartCount = (item: any): number | undefined => {
  return item.partCount;
};
</script>

<style scoped lang="less">
.footer {
  text-align: right;
  .btn + .btn {
    margin-left: 10px;
  }
}

.media-container {
  display: flex;
  flex-wrap: wrap;
  background-color: var(--bg-hover);
  justify-content: center;
  margin-top: 20px;
  padding: 10px 0;
  gap: 10px;

  .media {
    padding: 10px;
    background-color: var(--bg-card);
    border: 2px solid var(--border-primary);
    border-radius: 5px;

    width: 160px;
    .cover-wrapper {
      position: relative;
      width: 160px;
      height: 100px;
    }
    .cover {
      width: 160px;
      height: 100px;
      object-fit: cover;
    }
    .part-count {
      position: absolute;
      right: 4px;
      bottom: 4px;
      background-color: rgba(0, 0, 0, 0.7);
      color: #fff;
      font-size: 12px;
      padding: 1px 5px;
      border-radius: 3px;
      line-height: 1.4;
    }
    &.selected {
      border-color: var(--color-primary-active);
    }
  }
}
.card {
  @media (max-width: 628px) {
    :deep(.n-card-content) {
      padding: 10px;
    }
    .haeder {
      flex-wrap: wrap;
    }
  }
}
</style>
