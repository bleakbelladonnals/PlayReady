# PlayReady 电脑网页工作台

当前正式首页连接本机 Codex，使用桌面端同一界面、工程目录、制作后台和审批流程。运行 `npm run desktop:web` 自动打开并连接网页，电脑保持开机、联网和后台运行。完整配置见 [浏览器连接本机工作台](desktop-web.md)。

## 原百炼独立体验路径记录

以下说明保留此前独立云端生成路径及已发布游戏，当前工作台不使用这一生成入口。


访问者直接输入游戏想法，即可创建小型 2D 网页游戏。服务端使用 `qwen3.8-flash` 规划、编写和审查游戏，使用 `qwen-image-3.0` 绘制背景和角色素材，再进行真实浏览器试玩检查。通过检查后可以试玩、下载 ZIP，并继续提交修改要求。

全站每天最多接受 20 次制作请求，新建和继续修改共用这个额度。本地服务按提交顺序执行；云端使用数据库事务领取任务，避免同一制作请求重复执行。项目修改和下载权限保存在创建者的浏览器中，试玩链接可以分享给别人。

## 本地启动

需要 Node.js 22 或更高版本，以及阿里云百炼同一地域、同一业务空间的 API Key 和兼容模式地址。

```bash
npm ci
npm run web:build
npm run web:install-browser
npm run web:setup
npm run web:serve
```

打开 `http://127.0.0.1:8787/`，填写游戏想法即可创建项目。已经完成配置和安装时，只需运行 `npm run web:serve`。服务运行期间保持终端窗口打开。

`web:setup` 会让你选择 Key 的地域、填写百炼控制台「业务空间详情」中的 Workspace ID，并在终端里隐藏输入 Key。配置保存到被 Git 忽略的 `.env.web.local`，权限为 `600`；后续启动优先读取本机配置。若仅需修正 Workspace ID，运行 `npm run web:workspace -- 你的WorkspaceId`。

## 部署到子域名

最终部署域名为 `https://ludoready.bleakbelladonna.com`。EdgeOne 托管静态页面与短接口，已有 CloudBase 环境保存项目状态，原生腾讯云 SCF Event 函数执行游戏制作和真实 Chromium 试玩，不使用需要自行维护的云服务器。TXT 归属、正式 CNAME 和免费 HTTPS 证书已完成；正式地址通过严格证书校验并实测返回 200，电脑首页已在实际浏览器查看。现有个人主站保持不变。

当前最终接线部署 `dpt9yxwoimkh` 已发布。原生 SCF 已真实验证 Chromium 启动、中文 Canvas 渲染和两个独立 BrowserContext；通过私有存储接口进行 Blob 二进制与 JSON 往返也已通过。新接苹果项目已完成真实千问规划、生图、审查、SCF 浏览器完整试玩和发布下载：Host 100 分、6 项全部通过、无运行错误，ZIP 与公开文件逐项相同；失败草稿的 6 个素材哈希保持不变。同项目只改标题的继续修改也已通过：revision 2 成功发布，Host 100 分、6 项全部通过、Reviewer pass；6 个素材哈希不变，制作期间旧版本仍可公开试玩和授权下载，最终公开文件与 ZIP 逐项相同。初次制作暴露的 terminal 34 秒等待/15 秒时限冲突已增加累计输入预算校验，修正保留原 30 秒游戏规则与素材。

### 云端完整流程

1. EdgeOne 提供页面及项目接口，访问者输入想法直接创建项目。
2. 短接口调用现有 CloudBase 状态桥，以数据库事务保存项目与访问权限、核算每日次数；新建和修改先进入 `queued`。
3. 原生 SCF `ludoready-worker` 由每分钟定时事件或受保护的唤醒请求触发，调用状态桥的 `claim-next` 原子领取最多一个任务。已有运行任务时不再领取，领取返回的 `runId` 和项目版本用于后续进度与成品回调，避免重复执行和旧任务覆盖新修改。
4. SCF 在自身运行环境中执行千问规划、绘图、代码生成、真实 Chromium 试玩、独立图片审查和最多 3 轮修复。图片继续真实进入实现与审查；真实试玩门槛不因更换托管方式而降低。
5. SCF 通过受保护的 EdgeOne `/api/worker/storage` 回调读写私有 Blob，保存素材、游戏文件、草稿、制作记录、试玩证据和分片下载包；CloudBase 保存进度和已发布版本。
6. 页面读取真实进度，完成后支持试玩、下载和继续修改。修改失败时保留旧成品及可恢复的草稿；关闭网页不会取消已由 SCF 领取的异步制作任务。

### 资源与配置

| 部分 | 当前配置与职责 |
| --- | --- |
| EdgeOne | 静态页面、创建/修改/查询/下载短接口、受保护的 worker 唤醒及私有 Blob 存储回调；此路径不使用 Makers Agents 或 Sandbox。 |
| CloudBase | 现有环境 `zaowutai-d5gkmk1fh36dd0fda`，`ap-shanghai`；PostgreSQL 的 `ludoready_projects`、`ludoready_usage` 和事务 SQL 函数，以及现有 `ludoready-state` Event 状态桥。未升级 CloudBase 付费套餐。 |
| 原生 SCF | `ap-guangzhou`、`ludoready-worker`、`Nodejs20.19`、1024 MB、1800 秒、`AsyncRunEnable: TRUE`；每 1 分钟定时领取任务。状态服务对运行中的任务保留 31 分钟租约，排队任务继续等待。 |
| SCF 资源包 | 已购 110 元备案资源包，有效期为 2026-08-31 至 2031-08-31，用于原生 SCF Event 资源抵扣。百炼模型与生图费用仍按百炼实际调用计量。 |

EdgeOne 构建命令为 `npm run web:build:edgeone`，输出 `dist/edgeone`；原生 SCF 构建命令为 `node scripts/build-scf-worker.mjs`，输出 `dist/scf-worker` 和 `dist/scf-worker.zip`。构建不会部署、调用模型或读取本机凭据。状态服务代码位于 `src/web/cloudbase`，worker 代码位于 `src/web/scf`。

服务端环境变量按职责配置：

| 服务 | 环境变量 |
| --- | --- |
| EdgeOne | `WEB_PUBLIC_ORIGIN`、`DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`LUDO_STATE_URL`、`LUDO_STATE_SECRET`、`LUDO_WORKER_URL`、`LUDO_WORKER_SECRET`。当前创建/修改接口仍检查百炼配置是否齐全，模型请求由 SCF 执行。 |
| 原生 SCF worker | `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`LUDO_STATE_URL`、`LUDO_STATE_SECRET`、`LUDO_STORAGE_URL`、`LUDO_WORKER_SECRET`。`LUDO_STORAGE_URL` 指向同站点受保护的 `/api/worker/storage`。 |
| CloudBase 状态桥 | `LUDO_STATE_SECRET`、`LUDO_PG_API_KEY`。PG API Key 对应 `service_role`，仅配置在状态函数后端。 |

上述密钥通过平台服务端环境变量私有配置，不进入网页或部署 ZIP。worker 与 EdgeOne 使用相同的 `LUDO_WORKER_SECRET` 保护唤醒及 Blob 回调，状态桥调用使用独立的 `LUDO_STATE_SECRET`；浏览器只持有自身项目的访问权限。部署文件不包含本机 `.env.web.local` 或 `.ludoready-web`，本机已有项目不会自动迁移。模型继续使用 `qwen3.8-flash` 和 `qwen-image-3.0`。

### 历史故障与验证记录

此前 Makers 路径曾成功创建云端项目并完成千问规划及两次 Qwen Image 生图，但没有发布新的可玩游戏：森林项目 `3d13d8b8-f726-4d46-9dc2-05f3886600c3` 用完 3 轮修复后未通过真实试玩检查，接苹果项目 `dbba11ea-e06a-414c-89ca-9fc18c693ac5` 在第一次修复时返回无效格式。[百炼结构化输出说明](https://help.aliyun.com/zh/model-studio/qwen-structured-output)明确，多模态输入的 `json_schema` 会自动降为 `json_object`，不保证符合指定结构；生成流程因此仍执行本地结构校验，格式问题进入剩余修复轮，不能作为通过结果。

项目 `ba860049-4192-41e4-b86f-ee668275c6f2` 的 revision 1 在任何千问调用之前启动失败，诊断确证 `SandboxNotAvailableError`、`Monthly sandbox GB-s quota exceeded`、`SANDBOX_LIMIT_EXCEEDED`，本次没有新增生图费用。此故障属于已替换的 Makers Sandbox 路径；当前原生 SCF 制作路径不再依赖该月度沙箱额度，也不需要提交原沙箱提额工单。

本地真实千问验证已通过一次已有游戏的标题修改：共 3 次请求，Host 得分 100、6 项检查全部通过，Reviewer 返回 pass，9 个素材文件哈希保持不变。这验证了本机已有游戏的标题修改与素材复用，不能代替当前云端新建与修改验收。

此前 Makers 云端运行检查确认临时文件、Node HTTP、Blob、浏览器导航及截图可用；已有森林游戏在该路径真实试玩得分 100，全部检查通过且没有运行错误，主动断开连接后的延迟任务也能完成。这些属于历史运行能力证据，当前原生 SCF 的完整制作、新游戏发布及继续修改已按前述证据通过。

域名的六项线上服务检查已通过：首页与部署产物一致、诊断仅创作者可读、额度故障可追踪、创建接口拒绝空要求、错误来源不能创建、失败草稿不能作为成品下载。这些检查也不代替完整新游戏制作验收。

资料依据：[SCF 运行环境](https://cloud.tencent.com/document/product/583/11060)、[SCF 异步执行](https://cloud.tencent.com/document/product/583/73923)、[EdgeOne 普通云函数限制](https://edgeone.ai/document/196117784807596032)。

## 运行方式

- 图片数量与文本调用次数取决于游戏规划、素材要求和修复次数；最多进行 3 轮修复。费用以百炼实际计量为准。
- 生成的游戏在受限浏览器环境中试玩，不能访问网站 Cookie 或外部网络。
- 本地版本的项目文件、进度和访问权限保存在 `WEB_DATA_DIR`；云端版本使用独立的持久化存储，不会自动带入本地已有项目。
- 本地版本使用一个 Web 服务进程。服务重启会将排队或制作中的项目标记为中断，创建者可在原项目页面继续修改。

## 2026-09-28 最新域名状态

最终地址为 `https://ludoready.bleakbelladonna.com`。TXT、正式 CNAME、免费 HTTPS、严格 TLS 校验、电脑首页及最终域名的六项线上服务检查已完成。当前原生 SCF 接线部署 `dpt9yxwoimkh` 已发布，真实新建、失败草稿恢复、完整试玩、发布下载和只改标题的继续修改均已验收通过；旧 Sandbox 月度额度不再是当前制作路径的依赖。没有新增主域名、主域名套餐或云服务器。
