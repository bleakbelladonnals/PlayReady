# Astra 鹈鹕骑车

LudoReady 的本地三维展示。保留海岸与摄影棚、三种光线、两种骑行速度、拖动旋转、滚轮缩放、自动环绕及暂停操作。进入后自动骑行，不播放声音。

来源、固定提交、模型归因、许可及改动记录见 [SOURCE.md](SOURCE.md)。上游模型元数据保留在 [PROVENANCE.json](PROVENANCE.json)，应用与场景使用 [MIT 许可](LICENSE)。

在仓库根目录运行 `node scripts/build-showcase-astra.mjs`，生成入口 `src/renderer/public/showcases/astra/index.html`。运行时不需要 API、账号、服务器接口或外部资源。

上游运动学检查可通过 `node --test src/showcases/astra/test/kinematics.test.js` 运行。
