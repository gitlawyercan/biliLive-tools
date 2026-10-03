// 验证 buildOutputBase 修复后的补前缀逻辑（与 videoGroupScan.ts 修改保持一致）
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

function buildOutputBase(groupName, autoPrefix = "") {
  let base = groupName.replace(EMOJI_RE, "").replace(/[<>:"/\\|?*]/g, "_").trim();
  if (!base) base = "未命名";
  if (autoPrefix) {
    let prefix = autoPrefix.replace(EMOJI_RE, "").replace(/:/g, "：").replace(/[<>"/\\|?*]/g, "_").trim();
    if (!prefix.endsWith("：")) prefix = `${prefix}：`;
    const prefixBody = prefix.slice(0, -1);
    // 修复点：已含本次前缀主体，或名称中已存在「xxx：」前缀段（全角冒号）→ 不再补
    if (prefixBody && !base.includes(prefixBody) && !base.includes("：")) {
      base = `${prefix}${base}`;
    }
  }
  return base;
}

const cases = [
  // [分组名, 本次设置前缀, 期望输出, 说明]
  ["小代_2026年10月3日", "萌妹精选", "萌妹精选：小代_2026年10月3日", "干净分组名 → 正常补前缀"],
  ["萌妹精选：小代_2026年10月3日", "萌妹精选", "萌妹精选：小代_2026年10月3日", "已含本次前缀 → 不补（fix2 行为保持）"],
  ["萌妹精选：小代_2026年10月3日", "萌妹直播", "萌妹精选：小代_2026年10月3日", "已带其他前缀段 → 不补（本次 bug 修复）"],
  ["萌妹精选：小代_2026年10月3日", "萌妹直播：萌妹精选", "萌妹精选：小代_2026年10月3日", "已带前缀段+完整两级前缀 → 不补"],
  ["小代_2026年10月3日", "萌妹直播：萌妹精选", "萌妹直播：萌妹精选：小代_2026年10月3日", "干净分组名+两级前缀 → 正常补"],
  ["萌妹直播：萌妹精选：奥特琪_2026年10月2日", "萌妹精选", "萌妹直播：萌妹精选：奥特琪_2026年10月2日", "完整嵌套名 → 不补（注释原例）"],
  ["张三_2026年9月28日", "", "张三_2026年9月28日", "无前缀设置 → 原名"],
  ["蜜兔蜜兔🐱_2026年10月3日", "萌妹精选", "萌妹精选：蜜兔蜜兔_2026年10月3日", "emoji 剔除后正常补"],
];

let pass = 0;
for (const [group, prefix, expect, desc] of cases) {
  const got = buildOutputBase(group, prefix);
  const ok = got === expect;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} [${desc}]`);
  if (!ok) console.log(`  输入: (${group}, ${prefix})\n  期望: ${expect}\n  实际: ${got}`);
}
console.log(`\n${pass}/${cases.length} PASS`);
process.exit(pass === cases.length ? 0 : 1);
