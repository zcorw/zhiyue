# Stage 0 · 平台与运行方式

设计调研已完成。首选验证方案为 AIUI Studio Global 的沉浸式 AIUI。目标固件的真机验证待进行。

## 用户已确认

- 目标设备为 **Rokid スマートAIグラス 国际版**，眼镜系统版本为 **1.28.016**。用户报告 Hi Rokid 已更新到最新版，具体版本号留待真机记录。
- 手机可以留在口袋里提供网络。选文章、翻页和返回都在眼镜上完成，优先使用镜腿触控或眼镜按键。
- 首版阅读知声文章。可读文章的范围、内容同步方式和访问授权将在后续阶段确定。

## 官方资料核查

| 项目 | 文档结论 | 知阅待验证 |
| --- | --- | --- |
| 显示与输入 | 国际版资料列出双眼单色绿显示和镜腿触控。AIUI 页面事件文档为 Rokid Glasses 列出方向、确认和返回事件。Hi Rokid 可调整触控板滑动方向。 | 在目标固件确认实际可用绘制区域、事件映射、系统默认返回与触控启动入口。 [国际版设备介绍](https://global.rokid.com/en-deutsch/blogs/academy-glasses/glasses-1-1-overview) · [AIUI 事件](https://github.com/yodaos-project/AIUI/blob/main/skills/aiui-dev/references/events.md) · [日本版更新说明](https://jp.rokid.com/blogs/news/rokid-glasses-ota-updates) |
| AIUI 运行与安装 | 沉浸式 AIUI 支持独立界面。Global 调试指南用 AIX 资源包和 Hi Rokid 更新眼镜，再通过语义匹配启动。 | 确认本机开发入口及手机锁屏时的眼镜端启动方式。 [AIUI 框架](https://js.rokid.com/AIUI/guide/quickstart?lang=en-US) · [Global 快速入门](https://js.rokid.com/AIUI/guide/quickstart/quickstart?lang=en-US&version=latest) |
| AIUI 联网 | Rokid 说明眼镜侧 AIUI 的 HTTPS 请求经蓝牙交给手机端 App 转发。 | 实测手机锁屏后请求能否完成。 [AIUI 运行时说明](https://js.rokid.com/blog/002-aiui-beta-overview) |
| 眼镜端原生应用 | Rokid 列出 YodaOS-Sprite 眼镜端 Android 应用、CXR-S 与直接使用硬件的开发路线。 | 作为备选，若 AIUI 真机验证遇到影响首版的问题，再核查国际版的安装、启动、按键分发和网络。 [Rokid 开发路线](https://kr.rokid.com/43) |
| 版本匹配 | 官方下载页列出的 Hi Rokid 1.16.0 要求眼镜系统 `1.28.016-20261029-150201`。用户提供的系统版本号与此前缀一致。 | 真机时记录完整固件、Hi Rokid 版本和开发者入口是否可见。 [官方版本说明](https://global.rokid.com/pages/app-download) |

## 首选验证方案

以沉浸式 AIUI 作为后续设计基线，候选实现用 JavaScript、WXML 和 WXSS，在眼镜显示独立阅读界面，由 Hi Rokid 转发 HTTPS。按 Global Studio 模拟器与真机分开验收。若触控启动、事件映射或后台联网达不到首版要求，再评估眼镜端原生路线。

最小平台验收使用虚构内容。先在 Global Studio 模拟确认方向、确认和返回行为。真机阶段检查资源包安装、眼镜端语音启动、镜腿事件、文本可读性和音频输出。手机保持锁屏并连接眼镜时，从眼镜请求未缓存的测试内容，验证前后翻页、音频播放和返回。完整范围见 [Stage 1](stage-01-scope.md)。

知声的 [阅读库契约](../../tts-workbench/docs/CMS_READING.md) 记录了现有已发布文章分页接口和授权边界。接口是否适用于知阅、如何发放只读权限，以及是否可缓存，留待后续确认。联调前的平台验证使用虚构内容。

相邻的 `rokid-agent-audio-lab` 已记录源码与适配器协议测试、Chrome 播放和模拟听写。下表仅记录知阅自身的验证。

| 验证范围 | 当前状态 |
| --- | --- |
| 代码 | 未开始 |
| 模拟器 | 未验证 |
| 真机 | 未验证 |
| 部署 | 未开始 |
