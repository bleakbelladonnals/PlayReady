# Opus 海岸骑行来源与适配记录

- 上游仓库：https://github.com/riba2534/claude-opus-5-5-demo
- 上游目录：`pelican-bike/`
- 固定提交：`54adc1fb64155f9dd7c1c90ecae7b8185ac540b8`
- 提交时间：2026-09-23T07:54:15Z
- 取用日期：2026-10-10
- 作者标识：riba2534
- 模型归属：上游 README 声明由 Claude Opus 5.5 在 Claude Code CLI 中生成，1M 上下文、xhigh 推理强度。该声明对应上游作品，不代表本次 LudoReady 适配使用同一个模型。
- 原始提示词（上游 README）：生成一个鹈鹕骑自行车的 3D 页面，尽可能把你所有的能力全部都用上. 然后上传到 CDN 上, 把访问链接给我
- 上游 README 保存在同目录 `UPSTREAM-README.md`。

## 许可记录

上游 `pelican-bike/package.json` 的原始声明为 `"license": "ISC"`，本地保留原文件与原始 lock 文件。取用提交中未发现仓库根目录或该子项目独立的 LICENSE 文件，因此本地没有补写或伪造作者版权归属与许可正文。运行目录中的 `upstream-package.json` 是这一原始声明的副本。

运行包包含 Three.js 0.185.1 与其随包提供的 lil-gui 0.17.0，许可通知见 `THIRD_PARTY_NOTICES.txt`。原始子项目声明的 Three.js 版本为 0.186.0、lil-gui 为 0.21.0；本次构建复用 LudoReady 根目录已安装的依赖，没有安装额外依赖。

## 本次适配

- 保留鹈鹕、自行车、海岸、海浪、围巾、鱼、成就、昼夜与五种相机的源码和表现。
- 去掉开场大遮罩，进入即静音自动骑行；起始相机改为侧面跟拍，默认均衡画质。
- 移除页面内作者社交链接、分享、下载截图与独立全屏工具。来源、全屏与重置由 LudoReady 展示面板提供。
- 详细操作说明与参数面板默认收起，缩小常驻速度与得分面板，保留时间调整、抓鱼、跳跃与触屏操作。
- 添加宿主消息协议，独立控制暂停与声音；暂停时骑行、昼夜、海浪、角色、粒子和相机时间均不推进，恢复不会显示开场页面。
- Esc 通知宿主返回工作台，收到命令时校验 `event.source === parent`。
- 使用现有 esbuild 将所有运行依赖打包为普通 IIFE，再将脚本内联到已有内联样式的 `index.html`。全部运行资源包含在单个 HTML 中，可在没有同源权限的本地文件沙箱内加载；页面不使用 CDN、网络贴图、远程音频或 ES module。

## 构建与验证边界

在 LudoReady 仓库根目录运行 `node scripts/build-showcase-opus.mjs`。

输出位于 `src/renderer/public/showcases/opus/`，运行入口 `index.html` 已包含全部脚本与样式。封面、原始 package 许可声明与第三方许可通知继续保留，独立 IIFE 文件仅作为构建产物，不由页面加载。构建与静态依赖检查由素材适配阶段完成，实际加载、画面、声音、交互、全屏及暂停恢复由宿主整合验收统一检查。
