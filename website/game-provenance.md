# 官网游戏来源与复用记录

日期：2026-09-28。此文件供本地维护使用，不位于公开静态目录。

三个作品均取自本机已有 LudoReady 成品，没有为官网另造作品或改写游戏规则。`catalog.json` 中的原始创意来自对应项目记录。封面为原项目自动试玩留下的实际截图，未经重新生成或修图。

## 来源与已有验收

### 晴空小鸟

- 官网目录：`website/public/games/sky-bird/`
- 原项目：`/Users/bleak/LudoReady Games/web-2026-09-27-7164af22`
- 复制入口：`dist/index.html`，共 6 个运行必需文件，逐文件 SHA-256 一致。
- 来源路径：桌面版项目；本机 projects.json 状态 completed。
- 已有验收：`/Users/bleak/LudoReady Games/web-2026-09-27-7164af22/artifacts/playtest/latest/report.json`；2026-09-27T21:28:44.817Z；verdict=pass，score=100。加载、运行错误、画面、输入、持续渲染与重新开始检查通过。
- 封面：原项目 `artifacts/playtest/latest/screenshots/start.png`。
- 当前抽样复核：读取实际代码与已有验收，查看实际截图；源码依赖为项目相对路径。官网整合后的浏览器复核由官网交付阶段执行。

### 企鹅冰原跑酷

- 官网目录：`website/public/games/penguin-run/`
- 原项目：`/Users/bleak/Documents/ChatGPT/游戏项目/.ludoready-web/projects/000537d7-a409-4dca-b835-527d5fad3e13`
- 复制入口：`public/index.html`，共 8 个运行必需文件，逐文件 SHA-256 一致。
- 来源路径：旧网页生产路径；本地 state.json 状态 complete，hasPublished=true，已发布修订与当前修订均为 6。
- 已有验收：`/Users/bleak/Documents/ChatGPT/游戏项目/.ludoready-web/projects/000537d7-a409-4dca-b835-527d5fad3e13/artifacts/playtest/latest/report.json`；2026-09-27T12:01:16.288Z；verdict=pass，score=100。加载、运行错误、画面、输入、持续渲染与重新开始检查通过。
- 封面：原项目 `artifacts/playtest/latest/screenshots/jumped.png`。
- 当前抽样复核：读取实际代码与已有验收，查看实际截图；源码依赖为项目相对路径。官网整合后的浏览器复核由官网交付阶段执行。

### 森林金币挑战

- 官网目录：`website/public/games/forest-coins/`
- 原项目：`/Users/bleak/Documents/ChatGPT/游戏项目/.ludoready-web/projects/4547a1a4-1d32-4332-bdbd-d0c5808457f2`
- 复制入口：`public/index.html`，共 8 个运行必需文件，逐文件 SHA-256 一致。
- 来源路径：旧网页生产路径；本地 state.json 状态 complete，hasPublished=true，已发布修订与当前修订均为 6。
- 已有验收：`/Users/bleak/Documents/ChatGPT/游戏项目/.ludoready-web/projects/4547a1a4-1d32-4332-bdbd-d0c5808457f2/artifacts/playtest/latest/report.json`；2026-09-27T11:52:48.899Z；verdict=pass，score=100。加载、运行错误、画面、输入、持续渲染与重新开始检查通过。
- 封面：原项目 `artifacts/playtest/latest/screenshots/started.png`。
- 当前抽样复核：读取实际代码与已有验收，查看实际截图；源码依赖为项目相对路径。官网整合后的浏览器复核由官网交付阶段执行。

## 复制边界与检查

- 仅复制 HTML、CSS、JS 与被游戏引用的图像资源，以及一张真实试玩截图。
- 未复制账号配置、令牌、制作历史、自动试玩报告、生成提示词文件、素材清单、工作区配置、README 或源码开发依赖。
- 未使用 `.ludoready-private` 的内容。
- 复制后的 HTML / JS / CSS 已扫描绝对本机路径、账户标识、私钥块及常见密钥格式；未发现。
- 三个游戏的生产内容保持原样；封面与目录索引为网站展示用途新增。
- 本次仅准备本地官网文件，未发布或上传。

## 官网整合后的显示调整

游戏逻辑与素材保持原样；以下 CSS 调整只作用于官网副本，原工程未改动。

- 企鹅冰原跑酷：将 HUD 移到顶部标题下方，避免分数、生命、时间被底部触控按钮遮挡。
- 晴空小鸟：520px 以下缩小标题与开始面板，移除 320px 最小宽度，确保窄屏 iframe 内的按钮与说明完整可见。
- 森林金币挑战：官网容器使用较窄的竖向试玩区域。
- 三款的 catalog 入口均显式使用 index.html，兼容静态站点开发服务。

上文 SHA-256 一致记录是原始复制时的核对状态，以上 CSS 的最终版本已按实际验收更新。
