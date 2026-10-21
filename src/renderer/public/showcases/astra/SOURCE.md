# Astra 鹈鹕骑车展示来源

- 上游仓库：https://github.com/toankhontech/pelican-rider
- 固定提交：`e40244c8a7d78bee47ceb2819b2d02b04226474d`
- 上游演示：https://toankhontech.github.io/pelican-rider/
- 获取日期：2026-10-10
- 原始模型：GPT-6 Astra，reasoning effort `xhigh`，在 Codex 中迭代完成；来源为上游 `PROVENANCE.json`，原文件保留不变。
- 应用及程序化场景许可：MIT，原文保留在 `LICENSE`。
- Three.js：使用宿主已有依赖，MIT 全文随产物保存在 `THREE-LICENSE.txt`。

## 本地改动

1. 界面和操作提示改为中文，收紧顶部与底部留白，以三维场景为主体。
2. 移除作者品牌图片、品牌跳转、宣传页脚和外链入口；未获取 `public/tkt-icon.svg`、`public/tkt-logoname.png` 或其他品牌资产。
3. 保留原有程序化模型、动画、腿部几何、海岸与摄影棚、白天/日落/夜晚、慢骑/快骑、镜头拖动和自动环绕。
4. 进入后自动骑行，展示不包含音频。
5. 增加 LudoReady 父页面消息桥接，支持暂停、恢复、静音及 Esc 返回；暂停时冻结骑行和自动环绕，并保留光线、场景和手动镜头操作。
6. 使用项目现有 esbuild 和 Three.js 打包为普通 IIFE，再将脚本和样式内联到 `index.html`。全部运行资源包含在单个 HTML 中，可在没有同源权限的本地文件沙箱内加载；不再使用 Vite、CDN、远程字体或 ES 模块入口。
7. 移除上游验收专用 `hf-seek` 事件入口；原运动学检查随源代码保留。

## 重建

在 LudoReady 仓库根目录执行 `node scripts/build-showcase-astra.mjs`。

生成目录为 `src/renderer/public/showcases/astra/`，入口为 `index.html`。入口已包含全部运行脚本与样式；旁边的封面、原始来源记录和依赖许可证继续保留，独立 bundle 文件仅作为构建产物，不由页面加载。

## 与宿主的消息约定

只接受 `event.source === window.parent` 且 `type === 'ludoready-showcase'` 的消息。

- `command: 'pause'` 暂停骑行动画与自动环绕，同步场景内暂停按钮。
- `command: 'resume'` 恢复骑行与已开启的自动环绕，同步场景内暂停按钮。
- `command: 'mute' | 'unmute'` 均确认 `muted: true`，本作品没有音频。
- 首帧完成、暂停状态改变或收到有效控制命令后，上报 `{ type: 'ludoready-showcase-state', ready: true, paused: boolean, muted: true }`。
- Esc 上报 `{ type: 'ludoready-showcase-close' }`。

宿主和场景内按钮读写同一个 `paused` 状态，两处按钮可以交替暂停及继续。
