# 网页游戏自动试玩

网页后台调用 `runWebPlaytest(projectRoot)`，使用 Chromium 执行项目的
`.ludoready/playtest.json`。入口固定为 `public/index.html`。

## 服务器准备

```sh
npm ci
npm run web:install-browser
npm run web:build
```

浏览器安装命令使用 Playwright 对应的 Chromium，并在 Linux 安装所需系统库。
系统库安装可能需要服务器管理员权限；部署镜像时提前完成。安装 Chromium 的用户应与
运行网页服务的用户一致，或在安装和运行时指定同一个 `PLAYWRIGHT_BROWSERS_PATH`。

## 调用和结果

```ts
import { runWebPlaytest } from './playtest.js';

const report = await runWebPlaytest(projectRoot);
if (report.verdict === 'repair') {
  // 将 checks、observations 和截图交给制作流程修复，然后重新试玩。
}
```

该函数直接复用本机版 `GameplayExperienceEvaluator`，包括真实截图像素比较、
开始、移动、主要操作、暂停冻结、恢复持续运行和重新开始检查。
试玩配置只接受受限的键盘、鼠标、拖动和等待输入，不接受脚本或终端命令。

每次结果保存在 `artifacts/playtest/latest/report.json`，截图在同目录的
`screenshots/`。修复后重新运行会由宿主评测器更新结果并保留历史记录。

当前只针对电脑浏览器生成和验收，不做手机布局或手机截图。
文字断言失败时，报告会附上当前真实可见文字，帮助判断具体运行状态。

游戏只从项目 `public/` 读取文件。独立浏览器会话禁止外部网络、其他本机端口、
文件 URL、WebSocket、Service Worker、弹窗和下载，且不授予浏览器权限；
静态服务也禁止通过符号链接读取 `public/` 外的文件。
试玩不执行生成游戏中的 shell 或 npm 命令。

缺少浏览器时会明确提示执行 `npm run web:install-browser`。
函数结束或失败都会关闭浏览器会话、浏览器进程和临时静态服务。

## 针对性验证

```sh
npm test -- src/web/server/playtest.test.ts
```

此检查需要事先安装 Chromium，真实打开小型 Canvas 游戏并执行完整旅程，
同时验证静止画面会被判为需要修复，以及游戏不能访问其他本机端口或越界文件。

适配器使用的浏览器接口见 [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)、
[Page](https://playwright.dev/docs/api/class-page) 和 [Keyboard](https://playwright.dev/docs/api/class-keyboard)。

## 完整制作与继续修改

每个网页项目依次运行规划、素材制作、实现、源码审查、真实试玩和独立审查。
发现具体问题后最多修复三轮，每轮重新试玩并审查；宿主检查失败时，即使模型返回
通过也不会发布。代码模型和审查模型均收到真实素材图片，审查还收到宿主截图。

网页与本机共用 `src/shared/gameProduction.ts` 中的素材覆盖、动画、帧率、试玩规则，
网页使用百炼执行方式，不使用本机 Codex、Godot、3D 或音频服务。

初次素材包含一张独立环境背景及一张统一画风的角色/物体图集。
宿主裁切图集并去除与边缘连通的白色背景，保留透明动画帧和原始图集来源。
模型使用每个主体的真实路径，动态物体不烘焙进背景。
具体游戏质量由真实模型、素材和审查结果共同决定。

完成后，在项目页面的“继续修改”填写要求，提交后即可继续制作。
修改在独立工作目录中执行，失败保留已发布版本。初次失败可用原项目重新制作，
有完整、适用的既有素材时复用，避免重复付费生图。
每次修改同样计入全站每天20次制作名额。每个项目使用独立路径的session cookie，
同一浏览器创建新项目不会覆盖已有项目的修改权限。

项目保存原始想法、修改记录、规划和每轮制作/审查结果。公开下载只包含可运行的
public目录，试玩过程与后台轨迹保存在项目内部。

## 百炼输出与验收边界

千问请求关闭思考模式并使用嵌套 JSON Schema。宿主处理真实调用中出现的单对象
数组包装、完整 HTML 文档包装、首个准备步骤命名和超长等待分段；等待总时长保持
不变。处理后仍执行本机的严格试玩配置解析和完整浏览器验收，不修改游戏行为、
观察结果或通过阈值。

宿主还观察实际 Canvas 图片绘制：按图片或裁切区域的源宽高、目标宽高和绘图缩放
检查比例。超过 5% 的拉伸会将现有“可见画面”检查判为需要修复，写入同一份报告，
并阻止交付。镜像、等比例缩放和程序绘制的几何形状不受影响。

素材路径支持完整路径和“目录＋文件名”的正常拼接写法。代码、真实素材、运行
截图和操作断言共同参与审查。动画帧时间以毫秒计；暂停恢复应在已有真实运动
主体时观察。HTML 状态文字供真人与文字断言共同读取，画布负责游戏画面。
