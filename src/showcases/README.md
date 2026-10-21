# 鹈鹕骑车项目

两款作品通过一次性导入成为独立的 LudoReady 项目。左侧「MY GAMES」按普通项目显示名称、状态和项目菜单；点击后进入同一套制作工作台，左侧是项目记录与「继续制作」，右侧是「预览 / 素材 / 文件」，顶部显示制作阶段。

| 项目 | 保留的体验 | 来源与适配记录 |
| --- | --- | --- |
| 鹈鹕骑车 · Astra | 微缩海岸、摄影棚、三种光照、骑行节奏、镜头环绕 | [Astra SOURCE.md](./astra/SOURCE.md) |
| 鹈鹕骑车 · Opus 5.5 | 海岸骑行、变道抓鱼、跳跃、特技、成就、五种镜头、声音与昼夜 | [Opus SOURCE.md](./opus/SOURCE.md) |

模型归属来自上游作者记录。项目自己的来源文档保留仓库与固定提交；工作台记录本次实际导入与构建。后续「继续制作」使用输入栏当前选择的模型。

## 一次性导入

先退出本地 LudoReady，再指定现有用户数据目录：

```sh
npm run build:main
node scripts/import-pelican-projects.mjs --user-data "/absolute/path/to/existing/user-data"
```

脚本通过 ProjectStore 创建两个独立工程，复制可编辑源码、操作说明与来源档案，导入场景封面到素材库，并在各自目录安装依赖、构建 `dist/index.html`。现有项目和设置保持不变。用户数据目录中的 `pelican-project-imports.json` 保存导入记录；重复执行会跳过已有记录，包括后来重命名、编辑或删除的项目。应用启动不会自动添加或重新创建这两款。

## 打开和修改

启动 LudoReady 后，在「MY GAMES」选择对应项目。预览直接读取该项目的构建；「素材」包含场景封面，「文件」可查看场景与交互源码、`GAME_DESIGN.md`、`SOURCE.md` 和原作档案。下方「继续制作」可以提交新的修改要求。

每个导入工程均可独立构建：

```sh
npm install --ignore-scripts
npm run build
```

界面位于 `index.template.html`，生产代码位于 `src/`，构建入口为 `build.mjs`。更新后刷新工作台预览。P / Esc 暂停或继续，R 或画面中的「重来」按钮重置当前游戏；Opus 可通过 M 或声音按钮开关声音。具体玩法与按键见工程根目录 `README.md`。

## 源目录和验证记录

此目录保留导入基线；修改已有游戏应编辑对应独立工程，重复导入不会覆盖用户修改。`scripts/prepare-pelican-project.mjs` 负责新工程适配，`scripts/import-pelican-projects.mjs` 负责目录、素材与实际导入事件。

原 `build:showcases` 与 `smoke:showcases` 命令仍用于检查此目录的历史独立场景包；它们不更新已导入工程，也不代表当前工作台验收。当前预览由 `Inspector.tsx` 使用项目预览服务加载，项目导航统一由 `ProjectRail.tsx` 和 `App.tsx` 管理。
