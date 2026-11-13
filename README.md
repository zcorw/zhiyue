# 知阅 · Zhiyue

面向 Rokid 使用场景、以文字为中心的独立沉浸式浏览项目。

## 已确认的方向

- 项目名称：**知阅**；英文转写和目录标识采用 `Zhiyue` / `zhiyue`。
- 采用独立页面，不作为知声 CMS 管理页面的附属视图。
- 页面设计极简，主体以文字为主。
- 仅使用少量图标标识状态或区域。
- 用户要求建立新项目，并在该项目的新会话中开始后续设计与开发。

## 当前状态

目标设备为 Rokid スマートAIグラス 国际版，眼镜系统 1.28.016。眼镜端支持绑定知声账号、查看已发布文章、翻页及播放音频。真机已验证配对、阅读和 MP3 播放，1.0.8 调试版的音频内存缓存仍待真机复测。电脑预览使用内置演示数据。

2026-11-13 已补齐知声新版确认、自动续期和失败恢复，并针对确认请求长期等待新增独立 10 秒截止时间与恢复处理，33 项 Node 模拟回归通过。用户已反馈本次绑定修复测试通过，具体环境与资源包版本待补录，完整真机及长期授权场景另行验收。[修复记录](docs/zhisheng-binding-diagnosis-2026-11-13.md#确认接口长期等待的第二次修复)和[源码包 v2](artifacts/zhiyue-aiui-binding-fix-v2.zip)。

## 运行演示

在项目根目录运行：

```powershell
node serve-preview.mjs
```

打开 [知阅电脑预览](http://127.0.0.1:4178/preview/)。可用鼠标操作，也可以用方向键选文或翻页，按 Enter 确认或控制播放，按 Esc 返回。「第一班电车之前」和「窗边的一小格光」提供朗读音频。

眼镜端工程在 [`aiui/`](aiui/)，供 AIUI Studio Global 本地导入。具体操作与验证状态见[演示说明](docs/demo.md)。

知声实数据接入的手机绑定流程、启用条件和验证边界见[知声接入记录](docs/stage-07-zhisheng-integration.md)。

先阅读 [会话交接](HANDOFF.md)、[待办](TODO.md) 和 [项目概览](docs/project-overview.md)。后续通过 `ai-project-architect` 分阶段明确平台、范围、流程、页面和工程约定；已确认的名称与视觉方向无需重复询问。

## 资料索引

- [项目概览](docs/project-overview.md)：目标、确认事实和待确认事项。
- [设计原则](docs/design-principles.md)：文字优先和极简界面约束。
- [架构草案](docs/architecture.md)：职责边界；技术选型待定。
- [项目约定](docs/project-conventions.md)：当前工作方式与尚未确认的约定。
- [语言约定](docs/stage-setup-language.md)记录已确认的三项语言选择。
- [平台阶段记录](docs/stage-00-platform.md)跟踪设备、运行方式和输入的确认情况。
- [首版范围记录](docs/stage-01-scope.md)记录文章、启动方式和验收范围。
- [阅读与播放流程](docs/stage-02-flow.md)跟踪眼镜端交互与异常状态。
- [AGENTS.md](AGENTS.md)：后续开发代理的项目规则。
