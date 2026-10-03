# biliLive-tools

![Downloads](https://img.shields.io/github/downloads/renmu123/biliLive-tools/total)

这是一个直播的一站式工具，支持弹幕转换与视频压制并上传至B站，支持斗鱼、虎牙、B站、抖音、小红书、TikTok直播录制，支持[B站录播姬](https://github.com/BililiveRecorder)、[blrec](https://github.com/acgnhiki/blrec)、[DDTV](https://github.com/CHKZL/DDTV)、[oneliverec](https://www.oneliverec.cc/zh-cn/)的webhook。
如果你是录播man正在寻找xml弹幕转换、弹幕压制、webhook上传工具，如果你是切片man正在寻找下载录播视频工具，如果你厌倦了b站的多p上传，你可以来试试本软件。  
做这款工具的初衷是为了解决录播工具的碎片化，往往想完整处理一场带有弹幕的录播要使用多个软件的配合，一些工具只有CLI，加大了使用难度。  
软件的目标是开箱即用，体验优先，默认配置下满足大部分人使用需求，同时支持个性化需求来增加可用性。  
你可以在B站查看[系列教程](https://www.bilibili.com/video/BV1Hs421M755/)

因原作者的部分功能并不能很好的覆盖部分添加数百个直播间的录播man，因此笔者在源代码的基础上，根据需求修改定制了部分功能。

修改定制的功能如下：

1、续传功能中点击历史稿件出现当前投稿的分p数，以减轻前往官方投稿功能中查询分p数的负担，给部分强迫症录播man塞满200p提供便利；

2、抖音直播限定单场直播录制小时数，以减轻部分录制抖音团播的录播man后期剪辑去除打pk内容的压力；

3、视频合并功能重构，设置input、output文件夹一键扫盘后，根据前缀名、日期（年月日）分组然后一键合并，合并后可增加前缀，给部分强迫症录播man提供搜集便利。

<h3>感谢原作者 <a href="https://github.com/renmu123">renmu123</a>（<a href="https://github.com/renmu123">https://github.com/renmu123</a>）对项目的开源。</h3>

# 分支介绍

1、**master分支**：fork原作者完整的源代码，仅新增投稿的分p数显示的功能，且后续会保持与原作者上游仓库的更新但不再以此源代码发布新版本；

2、**test分支**：定制全部功能的源代码，在原作者发布的源代码的基础上定制了三个功能，后续会保持原作者上游仓库的更新，并且以此发布新版本。

# 功能介绍

- 支持斗鱼、虎牙、B站、抖音、小红书、TikTok多平台直播录制，支持FFmpeg、mesio、录播姬多种录制引擎，支持弹幕录制及更多高级选项
- 支持录播姬、blrec、DDTV、onelivrec等多个平台的webhook自动化处理
- 支持录制文件自动压制弹幕、B站上传、同步至网盘
- 支持任意录制平台基于文件监听的自动化支持
- 支持基于Danmakufactory的现代化XML文件转ASS的GUI
- 支持利用弹幕及高能点进行视频粗剪
- 支持批量进行视频压制、转码、合并、FLV文件修复
- 支持自动下载搬运斗鱼、虎牙录播至B站
- 支持下载斗鱼、虎牙、B站、快手的直播录像
- 支持多种类型的通知
- 录播优化的视频切片，基于LLM的音乐翻唱分割以及歌词识别

**如果你使用了本软件，希望你在简介标注仓库地址或保留默认tag，本软件不存在任何数据追踪，我想大致知道使用使用人群及情况**

![preview](./docs/public/preview.png)

# 在线文档

文档地址：https://docs.irenmu.com

# 更新历史

[更新历史](https://github.com/renmu123/biliLive-tools/blob/master/CHANGELOG.md)

# 安装

客户端可直接在 [release](https://github.com/renmu123/biliLive-tools/releases) 或 [夸克网盘](https://pan.quark.cn/s/6da253a1ecb8) 中下载，更多内容见[文档](https://docs.irenmu.com/guide/installation.html)

# 交流地址

交流 QQ 群：872011161

# 开发

具体见内容 [文档](https://docs.irenmu.com/development/guide.html)

## 关于PR

提 PR 前，最好先提一个 issue，以防重复或者 PR 不被接收

## WebUI项目地址

为github actions自动编译

地址：https://github.com/renmu123/biliLive-webui

# 赞赏

如果本项目对你有帮助，请我喝瓶快乐水吧，有助于项目更好维护。  
爱发电：[https://afdian.com/a/renmu123](https://afdian.com/a/renmu123)  
你也可以给我的 B 站帐号 [充电](https://space.bilibili.com/10995238)

# License

GPLv3

# 参考资料 & 鸣谢

<ul>
  <li>
    <a href="https://github.com/hihkm/DanmakuFactory" class="external" target="_blank"
      >DanmakuFactory</a
    >
  </li>
  <li>
    <a href="https://github.com/biliup/biliup-rs" class="external" target="_blank"
      >biliup-rs</a
    >
  </li>
  <li>
    <a
      href="https://github.com/BililiveRecorder/BililiveRecorder"
      class="external"
      target="_blank"
      >BililiveRecorder</a
    >
  </li>
  <li>
    <a href="https://github.com/renmu123/biliAPI" class="external" target="_blank">biliAPI</a>
  </li>
  <li>
    <a href="https://github.com/WhiteMinds/LiveAutoRecord" class="external" target="_blank"
      >LiveAutoRecord</a
    >
  </li>
</ul>

# DIY 更新日志

以下为本仓库在原项目基础上自行维护的改动记录（按版本倒序）。Docker 镜像同步发布至 DockerHub 与 GHCR（`ghcr.io/gitlawyercan/bililive-tools`）。

## 3.25.1-fix1（2026-10-03）

- **[feat] 抖音录制链路风控加固**（`packages/DouYinRecorder/src/douyin_api.ts`）
  对已添加直播间的状态探测/房间信息请求做指纹一致性与请求头强化（不动签名算法）：
  ① UA 全链路统一为 ABogus 内置版本（原 axios 119 / HTML 路径 133 Edg / ABogus 130 Edg 三种混用）；
  ② enter 接口参数与 UA 对齐（`browser_platform` MacIntel→Win32、`browser_version` 108→130）；
  ③ 补齐浏览器级请求头（document 导航头 / enter XHR 头 / `sec-ch-ua` Client Hints）。
  方案：a_bogus 用 UA 参与签名，签名 UA 与请求头 UA 必须严格一致，统一后签名-参数-UA 自洽；补头不参与签名，无兼容风险。已对真实服务器实测三条链路（ttwid 获取 / web enter / webHTML）全部正常。

## 3.25.1（2026-10-03）抖音风控专项

- **[feat] 抖音扫码登录全面抗风控加固**（`packages/http/src/services/douyinLogin.ts`）
  CDP 直连架构保持不变，在五项维度强化无头 Chromium 环境：
  ① webdriver 痕迹消除（CDP 直连无 WebDriver 层 + 每个新文档注入脚本防御性兜底）；
  ② UA / Client Hints 一致性（完整下发 `userAgentMetadata`，与 UA 中 Chrome 版本严格一致）；
  ③ JS 运行环境指纹补全（`plugins`/`mimeTypes`、`languages`、`hardwareConcurrency`、`deviceMemory`、WebGL 厂商/渲染器伪装真实显卡、`window.chrome`）；
  ④ 持久化浏览器 profile（默认复用固定目录，`DOUYIN_PROFILE_DIR` 可覆盖，容器内可挂载该目录跨重启复用；并发登录自动回退临时目录）；
  ⑤ 行为特征拟人（页面加载后模拟随机鼠标移动、交互延迟随机化）。
  另含三项低成本启动参数加固：`--disable-blink-features=AutomationControlled`、真实分辨率 `--window-size=1920,1080`、`--lang=zh-CN`（配合时区覆写 Asia/Shanghai，IP-时区-语言自洽）。
  方案：`Emulation.setUserAgentOverride` 携带完整 Client Hints + `Emulation.setTimezoneOverride` + `Page.addScriptToEvaluateOnNewDocument` 注入指纹补全脚本（先于页面脚本执行）；**移除 `Runtime.enable`**（该调用改变页面 console API 行为，是已知自动化检测向量，与 rebrowser-patches 结论一致），`Runtime.evaluate` 无需 enable 即可调用，二维码监听走 Network 域不受影响。
- **[fix] 文件浏览器：目录模式下双击文件夹可进入**（`FileBrowserDialog.vue`）
  原组件在目录模式（如视频合并选择扫描/输出目录）下单击文件夹仅做选中高亮，无法进入子目录，子目录路径只能手动输入。现改为单击选中、双击进入，符合通用文件选择器习惯。

## 3.24.1-fix3（2026-10-03）

- **[feat] Web/docker 模式新增斗鱼、抖音扫码登录**（`packages/http/src/routes/login.ts`、`services/douyinLogin.ts`、`RecordSetting.vue`）
  原项目登录按钮带 `v-if="!isWeb"` 仅在客户端显示，docker 部署后只能手动抓 Cookie。现设置页在 Web 模式下弹出二维码弹窗并轮询状态，扫码成功自动回填 Cookie。
  方案：斗鱼走服务端直连官方接口（`passport.douyu.com/scan/generateCode` 获取二维码 → `lapi/passport/qrcode/check` 轮询 → 登录地址换取 Cookie），无需浏览器；抖音因 SSO 接口存在 TLS 指纹级风控，服务端通过 CDP 驱动无头 Chromium 打开官方登录页，监听页面自身的 `get_qrcode`/`check_qrconnect` 响应完成登录（`docker/Dockerfile` 的 backend/fullstack 镜像内置 chromium，可用 `CHROMIUM_PATH` 覆盖）；客户端（Electron）登录方式不变。

## 3.24.1-fix2（2026-10-03）

- **[feat] 视频合并三项增强**（`29fd4fe8`）
  分组列表显示**合并后成品名称**；单文件分组支持**移动 / 重命名**（针对不符合命名规范的文件）；新增**可选移除源文件**开关（合并成功后自动清理分段文件）。
  方案：`videoGroupScan.ts` 返回合并后名称信息；`http/routes/task.ts` 新增移动、重命名、删除源文件参数；`VideoMerge.vue` 增加对应操作入口与开关。
- **[version] CLI 包版本同步为 3.24.1-fix2**（`91a32804`）
  修复 web/docker 模式下接口版本号与网页显示版本不一致的问题。
  方案：此前版本号只更新了主包 `package.json`，CLI 包仍返回旧值；将 `packages/CLI/package.json` 同步为同一版本号。

## 3.24.1-fix1（2026-10-02）

- **[fix] videoGroupScan 补充 Dirent 类型导入**（`6addcb17`）
  修复 CI 构建失败：`videoGroupScan.ts` 使用了 `Dirent` 类型但未导入，TypeScript 编译报错。
  方案：补充 `import type { Dirent } from "node:fs"` 类型导入。
- **[fix] 分组键只取日期部分**（`34762c34`）
  修复同一前缀同一天因时分秒不同被拆成多组的问题，导致一个分组只有一段、无法批量合并。
  方案：分组键由「前缀_日期时间」改为「前缀_日期」（去除时分秒）；组间排序改为码点序，与 v2 行为保持一致。

## 3.24.1（2026-10-02）

- **[feat] 视频合并重构：按「前缀_日期」扫描分组批量无损合并**（`3f65fa15`）
  面向 `{前缀}_{年月日时分秒}.ts` 命名的直播录制分段，自动按「前缀 + 日期」分组，勾选后批量合并为 `{前缀}_{日期}.ts` 单文件。
  方案：新增 `packages/shared/src/task/videoGroupScan.ts`（文件名中文日期解析、分组、按日期倒序排列）；`http/routes/task.ts` 新增分组扫描 / 批量合并接口；`VideoMerge.vue` 重写为分组视图（组名 / 文件数 / 总大小 / 多选）；合并默认 `ffmpeg concat -c copy` 无损，检测到时间戳跳变时自动切换 `setpts` 重编码修复模式，整体进度按各分组时长加权。

## 3.23.1-fix2（2026-10-02）

- **[fix] 「单场时长上限」在直播间设置中保存被丢弃**（`c59d1fef`）
  修复设置页填写的时长上限保存后丢失的问题。
  方案：`http/src/routes/recorder.ts` 白名单字段遗漏，透传 `maxDuration` 相关 2 个字段。

## 3.23.1（2026-10-02）

- **[DouYinRecorder] 新增 `maxDuration.ts`：单场录制额度记账模块**（`d6c983a4`，217 行）
  按场次记录录制时长额度，达到上限自动触发停止，防止录制失控占满磁盘。
- **[DouYinRecorder] 接入 5 处录制生命周期钩子**（`566c8257`）
  在录制开始、分段、停止等 5 个关键节点接入额度记账模块。
- **[app/Recorder] 设置页新增「单场时长上限」表单项**（`e6e1b1ee`）
  仅抖音平台可见，值随直播间设置持久化。
- 版本号更新为 3.23.1。
