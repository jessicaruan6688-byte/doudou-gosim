# server/doudou-agent-proxy.mjs

兜兜（GoSim）的家庭事件解析代理。把用户的一句自然语言（如"我打算休息 18 个月"）
交给 MiniMax 解析成**结构化事件 JSON**，供 App 侧映射到既有的确定性计算引擎。

**它不做任何财务计算**：只负责"把话变成字段"。所有现金覆盖月数、风险判断、
推演都在 App 内的确定性引擎（G3）完成。

## 为什么单独放服务端

- `bundle/` 里**绝不能**出现 API Key（平台规则：bundle 内不得有任何密钥/token）。
- 密钥只从服务端环境变量读取（`MiniMax` 账户配置）。
- 这也是平台推荐的"App 声明 `net` + 公网 HTTPS 端点"的形态（见下方"平台约束"）。

## 目录

```
server/
  doudou-agent-proxy.mjs   # 服务本体（零依赖，仅用 node:http / 全局 fetch）
  .env.example             # 环境变量模板
  package.json             # start / test 脚本
  test/
    stub-provider.mjs      # 本地假 MiniMax（OpenAI 兼容），用于无密钥自测
    proxy.test.mjs         # 测试套件（node --test）
```

## 运行

```bash
cd server
node --version           # 需要 Node ≥ 18（用到全局 fetch / AbortSignal.timeout）
export PORT=8787
export MINIMAX_API_KEY=***
export MINIMAX_BASE_URL=https://<你的 MiniMax 兼容端点>
export MINIMAX_MODEL=<你的模型名>
node doudou-agent-proxy.mjs
```

接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探测，返回 `{ok:true}` |
| POST | `/api/parse-event` | 请求体 `{ "description": "……" }`，返回 `{ok, event, meta}` |

错误码：`AI_NOT_CONFIGURED`(503)、`AI_INVALID_OUTPUT`(502)、`AI_PARSE_FAILED`(502)、
`INVALID_DESCRIPTION`(400)、`INVALID_JSON`(400)、`INPUT_TOO_LARGE`(413)、`NOT_FOUND`(404)。

## 自测（无需真实密钥）

```bash
cd server && npm test
```

测试会拉起一个本地假 MiniMax，覆盖：合法事件、缺失字段、非法模型输出、
模型超时、上游 HTTP 错误、输入校验、客户端取消、未配置。

## 平台约束（重要，决定能否真正接通）

OctoSense 脚本 App 访问网络需要 `manifest.json` 声明 `net` 能力 + `network.hosts`：

- 只允许 **`https://`**，`http://` 一律被拒；
- host 必须是**裸主机名**（小写、无端口、无路径、无通配符）；
- 本地/内网地址（如 `localhost`）被拒。

因此本代理**不能**用 `http://localhost:8787` 被 App 直接调用；必须部署到
**公网 HTTPS（443）的裸主机名**，并在 manifest 的 `network.hosts` 中声明该主机。
