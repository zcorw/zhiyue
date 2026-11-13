# 知阅架构草案

职责讨论草案。设计以眼镜端沉浸式 AIUI 和 Hi Rokid 后台网络转发为首选验证方案，依据见 [Stage 0 平台记录](stage-00-platform.md)。

## 已确定边界

本项目有自己的目录与独立页面，不写入知声 CMS 页面目录；不覆盖已有 Rokid 音频听写实验。

## 候选职责划分

| 边界 | 候选职责 |
| --- | --- |
| 界面 | 文字展示、目录、区域和状态提示 |
| 应用状态 | 导航、阅读会话、加载/错误状态与退出清理 |
| 内容适配 | 将选定来源的接口转换为本项目明确的数据结构 |
| 设备适配 | 把实际支持的输入、显示和媒体能力隔离在平台接口后 |

上述职责用于后续澄清，不表示现在需要建立四个包、四个服务或新增后端。是否需要服务器、数据库、账户、音频或缓存，均由确认后的首版流程决定。

首版读取知声授权范围内的全部已发布文章和附带音频。知声管理文章、发布版本及资产，知阅管理阅读与播放状态。内容接口负责授权和资源获取，设备能力负责实际音频输出。音频与发布版本的对应关系以及传输方式留待领域和接口阶段确认。

设备边界负责将镜腿输入映射为选文、确认、翻页和返回。具体事件以目标固件的验证结果为准。

正文翻页和音频播放各自更新状态。应用从正文返回列表时停止当前音频并释放播放器资源。

虚构演示的 AIUI 端和电脑预览各自处理渲染、输入和播放器生命周期，共用固定文章数据与本地音频资产。演示中的每个短段预先指定为一屏，真实文章的布局分页和内容接入在后续设计。见[演示说明](demo.md)。

知声接入时，眼镜只调用单独的 HTTPS 设备接口，手机确认沿用知声网页会话。知声管理账号、设备授权和媒体票，知阅按当前 `accountId` 与 `bindingId` 隔离阅读状态。详见[知声接入记录](stage-07-zhisheng-integration.md)。

## Renewable device authorization implementation

The client now supports automatic renewal and valid legacy-binding upgrades. See [device-renewal.md](device-renewal.md) for the coordinated protocol and verification boundaries. Local VM tests do not establish backend deployment or Rokid hardware acceptance. Existing fixed 24-hour pairing notes describe the legacy behavior.
