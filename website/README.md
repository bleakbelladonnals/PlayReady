# PlayReady 中文官网

首页包含产品介绍、制作流程、使用准备与常见问题。仓库不再附带示例游戏或试玩素材。

在仓库根目录运行：

```sh
node node_modules/vite/bin/vite.js --config website/vite.config.mjs
```

访问 `http://127.0.0.1:5188`。

本次已启动的成品预览为 `http://127.0.0.1:5189`。如需重启，构建后运行 `node node_modules/vite/bin/vite.js preview --config website/vite.config.mjs --port 5189`。

构建静态站点：

```sh
node node_modules/vite/bin/vite.js build --config website/vite.config.mjs
```

输出为 `website/dist`。只部署此输出目录，不部署仓库、用户项目目录或制作后台配置。当前工作未执行外部部署。

界面不依赖外部字体、图片服务或公共游戏 API。

## 验收

- FAQ 支持鼠标和键盘展开，手机宽度无横向溢出。
- 当前范围不包含安装包构建、上传或发行；接入真实下载地址后再增加下载入口。

## 范围覆盖

| 用户要求 | 对象与评价标准 | 资料依据 | 交付位置 | 状态 |
| --- | --- | --- | --- | --- |
| 中文官网 | 中文产品介绍、真实能力、清晰创作流程和使用准备 | README.zh-CN.md、docs/PRODUCT_FUNCTIONS.md、docs/desktop-web.md | index.html、style.css | 已交付 |
| DMG 不签名不公证能否使用 | 说明可行性与首次手动允许步骤 | Apple https://support.apple.com/zh-cn/102445 | 本次对话答复 | 已交付 |
| 外部上线、DMG 构建与上传 | 当前没有请求执行 | 当前用户范围 | 后续执行 | 明确不在范围内 |

## 已执行的验证

删除示例游戏后，应重新运行生产构建，并检查桌面与手机宽度下的首页、FAQ 和页面导航。
