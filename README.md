# Zhiyue · 知阅

[English](README.md) | [简体中文](README.zh-CN.md)

A standalone, text-first immersive reading application for Rokid glasses.

## Confirmed direction

- Product name: **知阅**; English name and directory identifier: Zhiyue / zhiyue.
- A standalone interface, separate from the Zhisheng CMS management pages.
- Minimal page design centered on text.
- A small number of icons identify states or regions.
- The user requested a separate project and a new project chat for subsequent design and development.

## Current status

On November 17, the user confirmed that real-device testing of the left/right tilt direction and body-layout fixes was complete, and requested code delivery and Zhixu updates only. Left tilt selects Previous, right tilt selects Next; confirmation activates the selected button. Body pagination now supports actual viewport constraints, offscreen and mounted-page Canvas measurement, and bounded readiness retries. All 93 client regression checks pass. No new packaging, resource update or deployment is performed in this delivery. The tested resource-package and Hi Rokid versions were not supplied; package 1.0.17 remains the earlier category-acceptance baseline. See [the acceptance and delivery record](docs/interaction-update-2026-11-17.md#用户真机验收与源码交付).

On November 17, the user confirmed device acceptance of the category-search fallback on glasses system **1.29.013**, resource package **1.0.17**. The Hi Rokid version was not supplied. The existing Zhixu feature and device task are complete based on that feedback; independent Studio details and version metadata remain separate. The delivered source is [79e2ca1](https://github.com/zcorw/zhiyue/commit/79e2ca141e9787defe6c24b4f31093f15c57f5ae). See [the acceptance record](docs/category-fallback-2026-11-17.md).

The combined source delivery includes the required interaction groundwork: explicit article/category pagination buttons, continuous text layout, and tilt focus. The separate list-button device checklist remains open; the latest acceptance statement applies to the two requested fixes. Earlier desktop preview checks cover focus, list boundaries and text reflow. See [tasks](TODO.md).

The November 17 runtime fix now addresses two storage defects verified in the actual Global Studio: wx/localStorage share a backend, so legacy cleanup deleted new values; key-value data also disappeared on simulator restart. Credentials and the stable installation ID now use an Agent-private file when OPFS is available, with initialization and verified-write barriers. The Crypto compatibility fallback is retained. All 63 client checks in the scoped commit snapshot passed. After the user approved pairing, the actual simulator loaded 31 published articles, retained the binding after rerun, and opened a real article again with HTTP 200. Use the [v3 scoped source package](artifacts/zhiyue-binding-runtime-fix-v3-20261117.zip) or rebuild `aiui/`. This fix is delivered on the working branch; device installation and real-device/cross-day acceptance remain pending. See the [diagnosis and evidence](docs/binding-runtime-fix-2026-11-17.md).

Draft-status filtering belongs only to the Zhisheng CMS article-management page. The mistakenly added glasses filter and draft access have been reverted; Zhiyue continues to read published articles. The long-term binding fix is retained. See the [scope correction](docs/cms-filter-scope-2026-11-16.md).

The local 2026-11-16 fix adds native persistent storage, a stable installation identifier, and matching Zhisheng changes that retain one binding per account and device installation. The connection page distinguishes permanent bindings from access-credential expiry. The November 16 source package is historical and is superseded by the November 17 v3 package above. Results and limits are in the [fix report](docs/device-binding-fix-2026-11-16.md). Deployment, installation of the updated glasses package, and real-device testing across days remain pending.

A local voice-search implementation was added on 2026-11-15: choose “语音检索” in the article list, let Rokid transcribe speech, and optionally use OpenAI on the Zhisheng server to interpret the text. A unique article opens directly; multiple results remain in a paginated list. The client passed 58 regression checks; the server passed 10 focused checks with one database integration check skipped. Desktop interaction with simulated text was checked. Real OpenAI, Global Studio, and device acceptance remain pending. See the [voice-search record](docs/stage-08-voice-search.md) for enablement requirements.

The target is Rokid Smart AI Glasses, international edition; the latest user-reported system is 1.29.013 (the initial baseline was 1.28.016). The glasses support Zhisheng account pairing, published-article browsing, pagination, and audio playback. Pairing, reading, and MP3 playback have prior real-device verification. The audio memory cache in debug version 1.0.8 still needs a device retest. The desktop preview uses built-in demonstration data.

On 2026-11-13, local fixes added the new confirmation protocol, automatic renewal, failure recovery, and an independent 10-second deadline for hanging confirmation requests. All 33 Node simulation checks passed. The user reported that the binding fix passed, without specifying the exact environment or resource-package version; broader device and long-term authorization acceptance remains separate. See the [fix record](docs/zhisheng-binding-diagnosis-2026-11-13.md#确认接口长期等待的第二次修复) and the historical [v2 source snapshot](artifacts/zhiyue-aiui-binding-fix-v2.zip).

The later local integration of PR #2 preserved both feature sets and CI, with 52 passing regression checks. The integrated source is in the aiui directory; the v1/v2 ZIP files are historical snapshots. See the [conflict-resolution record](docs/merge-conflict-resolution-2026-11-13.md).

## Run the demonstration

From the project root:

    node serve-preview.mjs

Open the [desktop preview](http://127.0.0.1:4178/preview/). Use the mouse or arrow keys to select articles and controls, activate pagination buttons to turn pages, Enter to confirm or control playback, and Esc to return. The simulated tilt buttons move focus only. “第一班电车之前” and “窗边的一小格光” include narration audio.

Import the [aiui source directory](aiui/) locally into AIUI Studio Global for the glasses application. See the [demonstration guide](docs/demo.md) for operation and verification status.

The phone-pairing flow, activation requirements, and real-data verification boundaries are in the [Zhisheng integration record](docs/stage-07-zhisheng-integration.md).

Start with the [handoff](HANDOFF.md), [task list](TODO.md), and [project overview](docs/project-overview.md). Continue platform, scope, flow, interface, and engineering decisions through the ai-project-architect stages; the confirmed name and visual direction do not need reconfirmation.

## Documentation

- [Project overview](docs/project-overview.md): goals, confirmed facts, and open decisions.
- [Design principles](docs/design-principles.md): text-first and minimal-interface constraints.
- [Architecture draft](docs/architecture.md): responsibility boundaries; final technology selection remains staged.
- [Project conventions](docs/project-conventions.md): current practices and unresolved conventions.
- [Language conventions](docs/stage-setup-language.md): the three confirmed language choices.
- [Platform record](docs/stage-00-platform.md): device, execution, and input decisions.
- [Initial scope](docs/stage-01-scope.md): articles, startup, and acceptance scope.
- [Reading and playback flow](docs/stage-02-flow.md): glasses interaction and failure states.
- [AGENTS.md](AGENTS.md): project rules for future development agents.
