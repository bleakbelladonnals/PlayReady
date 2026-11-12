# PlayReady 状态函数部署

现有 CloudBase 免费环境使用 PostgreSQL。PlayReady 使用专用表、一个事务 SQL 函数和一个 Event 函数；游戏生成、浏览器试玩及游戏文件由 EdgeOne 执行。

## 本地构建

在仓库根目录运行：

```sh
node scripts/build-cloudbase-state.mjs
```

输出目录为 `dist/cloudbase-state`，包含以下文件：

- `functions/ludoready-state/state.js`：从 `src/web/cloudbase/state.cjs` 复制的 CommonJS 入口，对应 `state.main`。
- `functions/ludoready-state/node_modules`：本地安装的 `@cloudbase/node-sdk@3.18.3` 及依赖。
- `functions/ludoready-state/package-lock.json`：本次上传依赖的锁定版本。
- `ludoready-state.zip`：仅函数入口、包说明及依赖。
- `cloudbaserc.json`：无密钥的 Event 函数配置，Nodejs20.19、256 MB、60 秒。

构建只安装 npm 依赖、生成本地文件，不登录、不部署，也不访问数据库。`installDependency: false` 和 `ignore: []` 保证本地依赖随函数上传。无需 `scf_bootstrap`。

## 云端资源与密钥

操作环境固定为 `zaowutai-d5gkmk1fh36dd0fda`，地域为 `ap-shanghai`。使用此环境已有 PostgreSQL，通过专用事务 SQL 函数 `public.ludoready_state(op text, input jsonb)` 处理项目、每日名额和任务领取；返回标量 JSON `{ status, body }`。建表和函数 SQL 由部署执行者单独应用，不通过构建脚本执行。

数据库权限使用表级 GRANT、RLS 和 SQL 函数内的 `service_role` 校验。角色缺失或不匹配时必须拒绝。不能只依赖 `GRANT EXECUTE`，[官方 RPC 文档](https://docs.cloudbase.net/database/postgresql/rpc)说明了这一限制。实际已通过原生 CLI 的 `CreateApiKey` 创建 PlayReady 专用后端 PG API Key，并确认角色为 `service_role`。没有申请永久管理员 CAM 密钥；已创建的 PG API Key 是后端持久凭证。无需增加 MongoDB 集合。

函数运行环境需要两个私有变量：

- `LUDO_STATE_SECRET`：至少 32 字符，必须与 EdgeOne 中的同名变量一致，用于验证状态请求。
- `LUDO_PG_API_KEY`：专用后端 PG API Key，用于调用 PostgreSQL RPC。

两者均通过函数环境变量或部署执行者的私有配置注入，不能写入此目录的模板、提交到仓库或打入 ZIP。`LUDO_PG_API_KEY` 不传给浏览器或 EdgeOne。未配置 `LUDO_STATE_SECRET` 或请求未提供正确凭据时函数返回 403，不访问数据库。

## PostgreSQL 调用路径

实际安装的 `@cloudbase/node-sdk@3.18.3` 中，`app.rdb()` 只有 `from()`，没有 `rpc()`。当前生产 `main` 的 `tokenProvider` 直接返回 `process.env.LUDO_PG_API_KEY`，请求官方 REST RPC：

```text
POST https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/rpc/ludoready_state
Authorization: Bearer <LUDO_PG_API_KEY>
Accept-Profile: public
Content-Profile: public
Content-Type: application/json
```

请求体为 `{ op, input }`，事务规则全部在 SQL 函数内完成。[REST RPC 文档](https://docs.cloudbase.net/database/postgresql/http/rpc)定义了端点和返回方式。`getClientCredential()` 得到的 opaque 管理员 token 在实际 RPC 中被拒绝，因此生产不使用它作为 PG 凭据。日志只保留安全的错误码、角色或权限类别，不记录密钥、令牌或请求头。

## Event 函数与 HTTP 网关

CloudBase CLI 3.8.4 的 `--httpFn` 会将函数类型改成 `HTTP` 并要求启动监听 9000 端口的 Web Server。现有状态桥使用 `exports.main(event)`，应保持 `Event` 类型，再绑定 HTTP 网关。[官方 HTTP 访问文档](https://docs.cloudbase.net/service/access-cloud-function)支持这种组合。

部署执行者完成登录及 PostgreSQL 专用表、事务函数配置后，在构建输出目录执行函数部署：

```sh
cd dist/cloudbase-state
npm exec --yes --package=@cloudbase/cli@3.8.4 -- tcb fn deploy ludoready-state \
  -e zaowutai-d5gkmk1fh36dd0fda --install-dependency false --force --json
```

部署使用私有配置注入 `LUDO_STATE_SECRET` 和 `LUDO_PG_API_KEY`，再创建 HTTP 网关：

```sh
npx --yes @cloudbase/cli@3.8.4 service create \
  -e zaowutai-d5gkmk1fh36dd0fda -p /ludoready-state -f ludoready-state --json
```

第一条是实际使用的部署方式，工作目录为 `dist/cloudbase-state`；`--force` 覆盖范围仅为已授权的 `ludoready-state` 函数，不使用 `--httpFn` 或 `--all`。第二条命令将已部署的 Event 函数绑定到默认网关的 `/ludoready-state`。CLI 源码读取函数类型，Event 使用网关 `Type: 1`，HTTP 使用 `Type: 6`。`service create` 是仍支持的兼容命令；[新版 `routes add`](https://docs.cloudbase.net/cli-v1/routes)需要已有自定义域名，本状态桥使用默认网关，不额外绑定域名。

网关路由创建成功后仍需确认环境已开通 HTTP 访问。若返回 `HTTPSERVICE_NONACTIVATED`，该 URL 尚不能供 EdgeOne 调用。将实际验收可用的完整 URL 配置为 EdgeOne 的 `LUDO_STATE_URL`，不要根据环境 ID 猜测地域或默认域名。网页浏览器不直接调用此 URL，由 EdgeOne 附加 `Authorization: Bearer <LUDO_STATE_SECRET>` 请求。

## 请求与响应核对

HTTP 网关传入的 Event 包含 `httpMethod`、`headers`、字符串 `body` 和可选 `isBase64Encoded`。现有状态函数直接支持这些字段。函数返回：

```js
{
  statusCode: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ job: null })
}
```

网关将 `statusCode`、`headers`、`body` 转成 HTTP 响应，EdgeOne 接收的 JSON 应直接含 `job`，不应再次出现 `statusCode` / `body` 外包装。无凭据请求应返回 HTTP 403；错误 HTTP 方法应返回 405；正确凭据下读取不存在的项目应返回 HTTP 200 和 `{ "job": null }`。这些检查不创建项目、不消耗制作名额、不调用模型。

已完成真实云端验证：无凭据请求返回 HTTP 403；使用专用 `service_role` PG API Key 调用 RPC 读取不存在的项目，返回 HTTP 200 和 `{ "job": null }`。这些结果确认了当前鉴权和读取路径，不创建项目、不调用模型。

完整模型制作流程及云端并发仍未验证。后续验收包括：每日名额最多 20 次、同一版本仅能领取一次、失败继续保留上一版 publication，以及完整模型制作和试玩流程。本地 HTTP 协议检查不等于这些验收完成。`createStateBridge` 仅保留给原本的 NoSQL 本地回归检查，生产 `main` 已使用 PostgreSQL 桥。
