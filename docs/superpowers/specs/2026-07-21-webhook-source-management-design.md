# Webhook 源管理 · 设计文档

> 面向开发者的前端实现设计。配合 `webhook-design-demo.html` 食用。
> 后端契约见 `agent-compose/docs/design/webhook_design.md` 与 `agent-compose/pkg/events/webhooks/http.go`。

## 1. 背景

当前痛点：

- agent-compose 后端已实现 webhook ingress（`POST /api/webhooks/:topic`）和 webhook source 管理（`GET/PUT/DELETE /api/webhook-sources/:source_id`）REST API，但 UI 没有对应入口
- 开发者要注册一个 webhook 源只能 curl 调 API，token 是手填的明文，没有 hash 存储
- 调用方不知道完整的 curl 命令格式，需要查文档拼 URL/header
- 测试一个源是否生效要回到终端发请求，看不到行内反馈

目标：在系统管理页新增 Webhooks tab，提供源注册/启停/删除/测试/curl 复制能力。

## 2. v1 范围

**做**：

- 系统管理新增 Webhooks tab（与 镜像/环境变量/能力服务 并列）
- 源列表表格：名称 / Topic 前缀 / 状态（含行内启停 toggle）/ Token 状态 / 行内操作
- 注册源 Modal：name + topic_prefix + 客户端生成的 token + 立即启用开关
- 注册成功 Modal：强提示"仅此一次"，展示完整 token + curl 示例
- 行内测试：发 POST 请求，行内状态条反馈结果
- 行内删除：弹确认对话框
- 行内 token 重生成：弹确认对话框
- curl 示例卡片：跟随选中行，会话内有 token 时显示明文，否则 `<your-token>` 占位

**不做**（v1 简化，后续迭代）：

- 实时请求日志（后端 `GET /api/events` 只返回入库事件，401/404/413 失败请求不进 event 表，无法完整呈现 demo 中的 live log）
- 编辑已有源的 name/topic_prefix/provider（要改只能删除重建）
- Provider / Signature 字段暴露（v1 固定 `provider: 'generic'`、`signature_type: 'none'`）
- 跨 tab 同步（多 tab 操作时本 tab 看到的状态可能过期，由测试请求的 404 兜底反馈）

## 3. 后端接口契约

后端已实现，REST 形式（非 Connect RPC），路径如下：

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| `GET` | `/api/webhook-sources` | 列出所有源 | daemon bearer |
| `PUT` | `/api/webhook-sources/:source_id` | upsert 源（存在则更新，不存在则创建） | daemon bearer |
| `DELETE` | `/api/webhook-sources/:source_id` | 删除源 | daemon bearer |
| `POST` | `/api/webhooks/:topic` | 发布事件（webhook 入口） | 免 daemon 鉴权，校验 source token |
| `GET` | `/api/events?topic=...&after_sequence=...&limit=...` | 列出事件（v1 不用） | daemon bearer |

**鉴权**：UI 通过 `authFetch`（已有 `src/lib/auth-fetch.ts`）调用，daemon bearer token 由 UI 侧 cookie/header 自动带上。**唯一例外**是测试请求 `POST /api/webhooks/:topic`，该端点免 daemon 鉴权（`daemon_auth.go:65`），使用 source 自身的 Bearer token。

### 3.1 SourceJSON 响应（GET / PUT 返回）

```ts
interface WebhookSource {
  id: string;                  // UUID，主键
  name: string;                // 显示名
  enabled: boolean;
  provider: string;            // v1 固定 'generic'
  topic_prefix: string;        // 如 'webhook.siem.alert.'
  has_token: boolean;          // 仅返回布尔，不返回明文
  token_header?: string;       // v1 不用
  signature_type?: string;     // v1 固定 'none'
  has_signature_secret: boolean;
  body_limit_bytes?: number;   // 0 = 用全局默认
  created_at: string;          // RFC3339
  updated_at: string;
}
```

### 3.2 SourceRequest 请求体（PUT）

```ts
interface WebhookSourceRequest {
  name: string;
  enabled?: boolean;           // 默认 true（首次创建时）
  provider: string;
  topic_prefix: string;
  token?: string;              // 传明文，后端 hash 存
  token_hash?: string;         // 直传 hash（v1 不用）
  token_header?: string;
  clear_token?: boolean;       // true 时清空 token_hash
  signature_type?: string;
  signature_secret?: string;
  clear_signature?: boolean;
  body_limit_bytes?: number;
}
```

**关键语义**（来自 `http.go:297-319`）：

- 更新时若不传 `token` 字段，后端保留原 `token_hash`
- 传 `token` 字段则覆盖 hash
- `clear_token: true` 清空 hash
- v1 启停切换时**不传 token 字段**，保留原 token

### 3.3 PublishResponse（POST /api/webhooks/:topic 成功）

```ts
interface PublishResponse {
  accepted: boolean;
  topic: string;
  event_id: string;            // 'evt_xxx'
  sequence: number;
  correlation_id: string;
}
```

### 3.4 Topic 前缀硬性约束

后端校验（`topic_event_store.go:766-772`）：

- 必须以 `webhook.` 开头
- 必须以 `.` 结尾
- 总长 ≤ 128
- 只允许 `[a-zA-Z0-9._-]+`

前端预校验完全对齐，避免 400 往返。

### 3.5 错误响应

后端返回 `{ "error": "<message>" }` 结构（见 `http.go` 各 `c.JSON` 调用）。UI 解析后展示在 Toast / Modal / 行内状态条。

| HTTP | 场景 | UI 反馈位置 |
|---|---|---|
| 400 | topic_prefix 格式错 / 已存在 | Modal 顶部红条 + 字段标红 |
| 401 | session 过期 | `authFetch` 自动跳登录（除测试请求） |
| 401 | 测试请求 token 无效 | 行内状态条 |
| 404 | 删除时源不存在 / 测试时源刚被禁用 | Toast / 行内状态条 |
| 413 | 测试请求体超限 | 不会发生（测试 payload 极小） |
| 409 | 测试幂等键冲突 | 行内状态条 |
| 5xx | daemon 异常 | Toast + 重试（仅 `GET` 提供） |

## 4. 架构与组件边界

仿 workspace 特性结构（`src/lib/workspace/` + `src/components/workspace/`）：

```
src/
├── lib/
│   ├── webhook/
│   │   ├── api.ts          # REST 客户端：list/upsert/delete/publishEvent
│   │   ├── types.ts        # WebhookSource, SourceRequest, PublishResponse 等
│   │   └── store.svelte.ts # 全局状态：sources[], sessionTokens, selectedSourceId
│   └── stores.svelte.ts    # Page 类型加 'webhooks'；buildHash 加 #/system/webhooks
├── components/settings/
│   ├── WebhookPanel.svelte          # 容器：拉取 sources、协调子组件
│   ├── WebhookSourceTable.svelte    # 表格 + 行内启停 + 行内测试 + 行内 actions
│   ├── WebhookRegisterModal.svelte  # 注册弹窗：form/creating/success 三态
│   └── WebhookCurlPreview.svelte    # curl 示例卡片
└── pages/
    └── SystemSettings.svelte        # 加 Webhooks tab + 路由
```

### 4.1 组件职责

| 组件 | 职责 | 不做 |
|---|---|---|
| `WebhookPanel` | 拉取 sources、持有 `selectedSourceId`、协调子组件 | 不直接发请求 |
| `WebhookSourceTable` | 渲染表格、行内启停切换、行内测试、行内删除、点击行选中 | 不管 curl 卡片 |
| `WebhookRegisterModal` | 表单 + 客户端 token 生成 + 提交 PUT + 创建后强提示卡片 | 不管编辑 |
| `WebhookCurlPreview` | 根据 `selectedSourceId` + 会话 token 渲染 curl 命令 + 复制按钮 | 不发请求 |

### 4.2 会话 token 缓存

核心安全边界，放在 `store.svelte.ts`：

```ts
// 永不持久化（localStorage / sessionStorage / cookie 都不写）
const sessionTokens = new Map<string, string>(); // sourceId -> plaintext token
```

明文 token 只活在内存 Map 里。所有需要明文 token 的操作（curl 复制、测试发送）都先查这个 Map。

**写入时机**：注册成功 / token 重生成成功。

**读取时机**：测试按钮可用性判断、curl 命令生成、行内测试请求发送。

**清除时机**：源被删除 / 页面卸载。

## 5. 数据流

### 5.1 初始加载

```
WebhookPanel mount
  -> store.loadSources()
  -> GET /api/webhook-sources
  -> 存入 store.sources: WebhookSource[]
  -> sessionTokens 不动（刷新后丢失，符合安全预期）
  -> 默认选中第一个源（驱动 curl 卡片）
```

### 5.2 注册新源

```
点"+ 注册源"
  -> 打开 WebhookRegisterModal (view: 'form')
  -> 用户填 name / topic_prefix
  -> Modal 内本地生成 token = 'tok_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  -> 用户可点"重新生成"重新 roll token
  -> 点"注册"
  -> view = 'creating'，按钮置灰 + spinner
  -> source_id = crypto.randomUUID()
  -> PUT /api/webhook-sources/{source_id}
     body: { name, enabled, provider: 'generic', topic_prefix, token, signature_type: 'none' }
  -> 成功:
     1. sessionTokens.set(source_id, plaintext_token)
     2. store.loadSources()  // 刷新列表
     3. view = 'success'，显示完整 token + 复制按钮 + curl 示例 + 强提示
     4. 用户点"我已保存，关闭"关闭 Modal
  -> 失败 (400 topic_prefix 格式错 / 已存在):
     view = 'form'
     顶部红条显示后端 error message
     topic_prefix 输入框标红
```

### 5.3 行内启停切换

```
点 toggle
  -> 乐观翻转 source.enabled
  -> 立即 disabled toggle + 显示 spinner（防连点）
  -> PUT /api/webhook-sources/:source_id
     body: { enabled: !prev, name, topic_prefix, provider, ... }
     不传 token 字段（后端保留原 hash）
  -> 成功: toggle enabled，移除 spinner
  -> 失败: 回滚翻转 + Toast "启停失败: <error>"
```

### 5.4 行内测试

```
点"⚡ 测试"
  -> 检查 sessionTokens.has(source_id) && source.enabled
  -> 不满足: 测试按钮 disabled，title 提示原因
     - 无 token: "需重新生成 token 才能测试"
     - 源停用: "源已停用，请先启用"
  -> 满足:
     1. 行末状态条: "发送中..." (黄色左边框 + spinner)
     2. POST /api/webhooks/:topic_prefix_去掉末尾点
        headers: Authorization: Bearer <token>, Content-Type: application/json
        body: { test: true, source: '<name>', ts: <unix_ms> }
     3. 202 -> 状态条: "✓ 202 Accepted · evt_xxx · sequence 123 · 14:32:15" (绿色)
     4. 401 -> 状态条: "✕ 401 · token 无效" (红色)
     5. 404 -> 状态条: "✕ 404 · 源未找到（可能刚被禁用）" (红色)
     6. 网络错误 -> 状态条: "✕ 网络错误，请检查 daemon 是否在线" (红色)
     7. 状态条保留 30s 后淡出，或下次点测试时覆盖
```

**注意**：测试请求从浏览器直发到 `/api/webhooks/:topic`。该端点免 daemon 鉴权（`daemon_auth.go:65`），用 source 自己的 Bearer token 即可。UI 与 daemon 同源（vite proxy / 反向代理），无 CORS。

### 5.5 行内删除

```
点"✕"
  -> 弹确认对话框:
     "确定删除源 <name>？此操作不可撤销。"
     影响清单:
     - 所有使用此源 token 的调用方将立即收到 401
     - YAML 中 scheduler.on("<topic_prefix>*", ...) 的订阅将不再被触发
     - 已入库的历史事件保留，可通过 /api/events 查询
  -> 确认后 DELETE /api/webhook-sources/:source_id
  -> 成功: 从 store.sources 移除 + sessionTokens.delete(id)
  -> 404: Toast "源已被删除" + 重新 loadSources
  -> 失败: Toast 显示后端 error
```

### 5.6 行内 token 重生成

```
点"↻ 重生成"
  -> 弹确认对话框:
     "重新生成 <name> 的 token 会使旧 token 立即失效。"
     影响清单:
     - 所有使用旧 token 的调用方将收到 401
     - 新 token 仅在本次会话显示，关闭后不再可见
     - 历史事件不受影响
  -> 确认后:
     1. 本地生成新 token
     2. PUT /api/webhook-sources/:id, body: { ..., token: new_token }
     3. 成功:
        - sessionTokens.set(id, new_token)
        - 弹"新 token 已生成"小卡片，显示完整 token + 复制按钮 + 警示语
        - 用户点"我已保存"关闭
     4. 失败: Toast
```

### 5.7 curl 复制

```
点"📋 curl"（行内）或点"复制"（curl 卡片）
  -> 生成 curl 命令:
     curl -X POST 'http://127.0.0.1:7410/api/webhooks/<topic>' \
       -H 'Content-Type: application/json' \
       -H 'Authorization: Bearer <token 或 <your-token>>' \
       --data '{
         "alert_type": "Webshell上传",
         "src_ip": "192.168.1.50"
       }'
  -> sessionTokens.has(id) ? 用明文 : 用 <your-token> 占位
  -> topic = source.topic_prefix.replace(/\.+$/, '')  // 去末尾点
  -> clipboard.writeText(cmd)
  -> Toast: "curl 命令已复制"
```

**URL host** 硬编码 `http://127.0.0.1:7410`。daemon 默认端口，外部系统直连 daemon（不走 UI 代理）。未来如需可配置再扩展。

## 6. UI 设计

### 6.1 表格列布局

| 列 | 宽 | 内容 |
|---|---|---|
| 名称 | 16% | `source.name` |
| Topic 前缀 | 24% | `source.topic_prefix`（等宽字体） |
| 状态 | 14% | 启用/停用 pill + 内嵌 toggle |
| Token | 16% | ● 已配置（绿）/ ○ 未配置（灰）+ 会话状态徽章 |
| 操作 | 30% | `📋 curl` `⚡ 测试` `↻ 重生成` `✕ 删除`（icon + 文字 button，右对齐） |

### 6.2 签名元素：行内测试状态条

采用 terminal I/O 隐喻编码"请求-响应"往返：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ > POST /api/webhooks/webhook.siem.alert                       14:32:15       │
│ < 202 Accepted · evt_a8f3c2d1 · sequence 123 · 耗时 38ms      [30s 后淡出]   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `>` 前缀 = 发送的请求行（method + path）
- `<` 前缀 = 收到的响应行（status · event_id · sequence · 耗时）
- 左边框颜色：绿（success）/ 红（error）/ 黄（sending）
- monospace 11px，行高 1.7
- 高度从 0 动画到 ~50px，避免行高跳变
- 30s 后自动淡出（CSS animation `opacity 1 -> 0`），从 Map 移除

状态条出现位置：紧跟在对应源行下方，占满整行宽度（`colspan="5"`）。

### 6.3 Token 列会话状态徽章

```
● 已配置 [会话内]    <- sessionTokens.has(id)
● 已配置 [需重生成]  <- !sessionTokens.has(id)
```

- 绿色徽章 "会话内"：明文 token 在内存 Map 中
- 黄色徽章 "需重生成"：明文 token 不在 Map 中（刷新页面后/他人创建的源）

徽章是次要信息，字号 9px，不抢主信息（`已配置`）的视觉权重。

### 6.4 注册 Modal 三视图状态机

```
form ─────点击"注册"─────> creating ─────成功─────> success
  ↑                          │
  └──────失败（400）─────────┘
```

**form 视图**：

```
┌─────────────────────────────────────────────────────┐
│ 注册 Webhook 源                              ×    │
├─────────────────────────────────────────────────────┤
│ 名称                                                │
│ [siem-alert                              ]         │
│ 在源列表里显示，可重复                              │
│                                                     │
│ Topic 前缀                                          │
│ [webhook.siem.alert.                    ]           │
│ YAML 里 scheduler.on("webhook.siem.alert.*", ...)   │
│ 通过此 topic 匹配。必须以 webhook. 开头、. 结尾     │
│                                                     │
│ 访问 Token                                          │
│ [tok_a8f3...e5d2  (只读)] [↻ 重新生成] [📋 复制]    │
│ ⚠ 仅在创建时显示一次，请立即保存                    │
│                                                     │
│ [●] 立即启用                                        │
│ 停用后所有发往此 topic 的请求返回 404              │
├─────────────────────────────────────────────────────┤
│                          [取消]  [注册]             │
└─────────────────────────────────────────────────────┘
```

**success 视图**（"强提示"核心）：

```
┌─────────────────────────────────────────────────────┐
│ ✓ 源已注册                              ×          │
├─────────────────────────────────────────────────────┤
│ ⚠ 这是您最后一次能看到此 token                     │
│ 关闭后此 token 将不再显示。如需再次获取，必须重新   │
│ 生成（会使旧 token 立即失效）。                     │
│                                                     │
│ 访问 Token                                          │
│ ┌─────────────────────────────────────┐ [📋 复制]   │
│ │ tok_a8f3c2d1e9b04f6e5d2a7c8b9f0e1d2c│            │
│ └─────────────────────────────────────┘            │
│                                                     │
│ curl 示例                                           │
│ curl -X POST 'http://127.0.0.1:7410/api/webhooks/   │
│   webhook.siem.alert' \                             │
│   -H 'Authorization: Bearer tok_a8f3...' \          │
│   --data '{...}'                                    │
├─────────────────────────────────────────────────────┤
│                              [我已保存，关闭]       │
└─────────────────────────────────────────────────────┘
```

**关键约束**：
- success 视图只有一个按钮"我已保存，关闭"，没有"返回修改"（PUT 已写库，返回无意义）
- 关闭后明文 token 仍留在 `sessionTokens` 中，所以表格里这一行的 curl/测试立即可用
- 关闭 = view 切回 form 并清空表单

### 6.5 curl 示例卡片

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ curl 示例                                                              [复制] │
│ 选中源后自动生成可复制的调用命令                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  siem-alert · webhook.siem.alert.                                            │
│                                                                              │
│  curl -X POST 'http://127.0.0.1:7410/api/webhooks/webhook.siem.alert' \      │
│    -H 'Content-Type: application/json' \                                     │
│    -H 'Authorization: Bearer tok_a8f3c2d1e9b04f6e5d2a7c8b9f0e1d2c' \         │
│    --data '{                                                                 │
│      "alert_type": "Webshell上传",                                           │
│      "src_ip": "192.168.1.50"                                                │
│    }'                                                                        │
│                                                                              │
│  ⚠ 包含明文 token，仅您当前会话可见                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**三种 token 状态**：

| 状态 | Authorization 行 | 底部提示 |
|---|---|---|
| 会话内有明文 token | `Bearer tok_a8f3...` | "⚠ 包含明文 token，仅您当前会话可见" |
| 会话内无 token | `Bearer <your-token>` | "替换 <your-token> 为您的源 token。如需新 token，点击表格中"↻ 重生成"" |
| 源未配置 token | `Bearer <your-token>` | "源尚未配置 token，请点击"↻ 重生成"" |

**语法高亮**（正则切分 + `<span>` 包装，不引第三方库）：
- `curl` / `-X` / `-H` / `--data`：紫色 / 黄色
- URL：蓝色
- Header 名：黄色
- 字符串值：绿色
- `<your-token>` 占位符：橙色背景

**无选中源时**：仅在 `sources.length === 0` 时出现，显示"点击上方表格中的源以查看 curl 示例"。

## 7. 错误处理 & 边界

### 7.1 HTTP 错误码映射

见 §3.5。

### 7.2 竞态与幂等

| 场景 | 处理 |
|---|---|
| 用户连点"注册" | Modal `view === 'creating'` 时按钮 disabled |
| 用户连点 toggle | toggle spinner 期间 disabled |
| 用户连点"测试" | `testStates.get(id)?.phase === 'sending'` 时按钮 disabled |
| 用户连点"删除" | 确认对话框"删除"按钮在请求 in-flight 时 disabled |
| loadSources 与单条 PUT 并发 | PUT 成功后总是触发 loadSources 重新拉，以服务端为准 |
| 多 tab 同时操作 | 不做跨 tab 同步；用户在另一 tab 删了源，本 tab 点测试会 404，状态条如实展示 |

### 7.3 Token 安全边界

| 边界 | 规则 |
|---|---|
| 持久化 | `sessionTokens` 严格不写 localStorage / sessionStorage / cookie |
| 控制台日志 | 不 `console.log` 明文 token |
| 网络请求 | 只在 `PUT /api/webhook-sources/:id`（创建/重生成时）、`POST /api/webhooks/:topic`（测试时）发送 token |
| curl 卡片 | 显示明文 token，但有底部警示语；用户主动复制才出剪贴板 |
| DOM | token 出现在 `<input readonly>` 和 `<pre>`，无 `type=password` 遮蔽（用户需要看到才能复制） |
| 页面卸载 | `beforeunload` 不特别清理（Map 随页面销毁）；`visibilitychange` 不主动清（切 tab 回来还要能用） |

### 7.4 Provider / Signature 默认值

v1 不暴露这些字段，PUT 时固定：

```ts
{
  provider: 'generic',
  signature_type: 'none',
  signature_secret: '',
  body_limit_bytes: 0,  // 0 = 使用全局默认（WEBHOOK_BODY_LIMIT_BYTES=1MB）
}
```

### 7.5 空列表

- 初始加载完成且 `sources.length === 0`：表格区显示空状态文案，不显示 curl 卡片
- `selectedSourceId` 在 sources 变化后自动校正：选中的源不在列表里则回退到第一个

### 7.6 daemon 不可达

- 任何请求网络层失败（fetch throw）：Toast "daemon 不可达，请检查服务状态"
- 列表加载失败：表格区显示"加载失败" + 重试按钮（重试只对 `GET` 提供，POST/PUT/DELETE 不自动重试，避免重复操作）

### 7.7 Session 过期

- 任何 401 走 `authFetch` -> `requireLogin()` 跳登录页
- 注意：测试请求 `POST /api/webhooks/:topic` 走 `fetch` 不走 `authFetch`（因为该端点免 daemon 鉴权，用 source token）；source token 失效返回 401 时不能跳登录页，要显示在行内状态条

## 8. 实现计划

**先搭容器壳子接入现有页面，再填叶子组件**，避免最后大爆炸式 wiring：

1. **类型 + API 客户端 + store**（无 UI）
   - `src/lib/webhook/{types.ts, api.ts, store.svelte.ts}` + 测试
   - 验证：`bun test src/lib/webhook/` 通过

2. **Page 类型 + 路由 + 空面板**
   - `stores.svelte.ts` 加 `'webhooks'` 到 Page union
   - `buildHash` 加 `#/system/webhooks`
   - `parseHash` 加 `webhooks` 分支
   - `SystemSettings.svelte` 加 tab + 空的 `WebhookPanel.svelte`
   - 验证：浏览器切到 Webhooks tab，看到空面板

3. **WebhookPanel 容器 + 表格渲染（只读）**
   - `WebhookPanel.svelte` 拉取 sources
   - `WebhookSourceTable.svelte` 渲染表格（无交互）
   - 空状态文案
   - 验证：浏览器看到列表（需手动 curl 创建一条种子数据）

4. **注册 Modal**
   - `WebhookRegisterModal.svelte` 三视图状态机
   - token 本地生成 + 复制
   - 表单校验
   - 提交后 sessionTokens 写入 + loadSources 刷新
   - 验证：浏览器注册一个源，看到 success 视图 + token

5. **行内启停 + 删除**
   - toggle 乐观翻转 + 失败回滚
   - 删除确认对话框
   - 验证：浏览器切换启停 + 删除一个源

6. **行内测试 + 状态条**
   - 测试按钮可用性矩阵
   - 状态条三态 + 30s 淡出
   - 验证：浏览器点测试，看到 202 + event_id

7. **curl 示例卡片**
   - `WebhookCurlPreview.svelte` 三种 token 状态
   - 行选中驱动
   - 复制按钮
   - 验证：浏览器选中不同行，curl 命令变化

8. **token 重生成**
   - 行内"↻ 重生成"按钮
   - 确认对话框
   - 重生成成功后弹"新 token"小卡片
   - 验证：浏览器重新生成 token，旧 token 测试返回 401

## 9. 测试策略

| 层 | 文件 | 覆盖点 |
|---|---|---|
| API 客户端 | `src/lib/webhook/api.test.ts` | list/upsert/delete/publishEvent 的 URL、method、body、headers；错误响应解析；401 不跳登录（仅 publishEvent） |
| Store | `src/lib/webhook/store.test.ts` | loadSources 成功/失败；sessionTokens 的 set/get/delete；selectedSourceId 在 sources 变化后自动校正 |
| 表格组件 | `src/components/settings/WebhookSourceTable.test.ts` | 渲染空/有数据；toggle 乐观翻转 + 失败回滚；测试按钮可用性矩阵；状态条三态；行选中驱动回调 |
| 注册 Modal | `src/components/settings/WebhookRegisterModal.test.ts` | 表单校验（topic_prefix 正则）；token 本地生成；提交成功后切 success 视图 + sessionTokens 写入；提交失败回 form + 错误展示 |
| curl 卡片 | `src/components/settings/WebhookCurlPreview.test.ts` | 三种 token 状态下 curl 命令生成；无选中源空状态；复制按钮回调 |
| 集成 | `src/pages/SystemSettings.test.ts`（已有，扩展） | Webhooks tab 切换；hash 路由 `#/system/webhooks` 解析 |

**测试不覆盖**（诚实声明）：

- 真 daemon 端到端：留给后端 integration test
- 跨 tab 竞态：v1 不处理，不测
- 浏览器剪贴板权限：`clipboard.writeText` mock，不测真实权限

## 10. 验收清单

**注册**
- [ ] 切到 Webhooks tab，URL 变为 `#/system/webhooks`
- [ ] 刷新页面后回到 Webhooks tab（hash 路由生效）
- [ ] 注册新源：填 name + topic_prefix -> 看到 token -> 关闭 Modal 后表格出现新行
- [ ] 注册时 topic_prefix 不以 `webhook.` 开头或末尾无 `.`，注册按钮禁用 + 红字提示
- [ ] 注册时 topic_prefix 与现有源重复，提交后 Modal 顶部红条显示后端 error

**表格交互**
- [ ] 表格行内 toggle 启停，刷新页面后状态保留
- [ ] 行内点测试，30 秒内看到 202 + event_id 状态条
- [ ] 没有会话 token 的源（刷新页面后），测试按钮 disabled 且 title 提示"需重新生成 token 才能测试"
- [ ] 停用的源，测试按钮 disabled 且 title 提示"源已停用，请先启用"
- [ ] 点击行非按钮区域，行变为选中状态（左侧蓝条），curl 卡片切换内容

**删除**
- [ ] 删除源弹确认框，确认后从表格消失
- [ ] 删除后 sessionTokens 中对应 token 被清除（curl 卡片中此源不再有明文 token）

**curl 示例**
- [ ] curl 卡片跟随选中行变化
- [ ] 会话内有 token 时 curl 显示明文 token
- [ ] 会话内无 token 时 curl 显示 `<your-token>` 占位 + 提示文案
- [ ] curl 复制按钮 + 行内 curl 复制按钮都能复制到剪贴板

**Token 重生成**
- [ ] 重生成 token 弹确认框，确认后弹"新 token"小卡片
- [ ] 重生成后旧 token 立即失效（再用旧 token 测试返回 401）
- [ ] 重生成后表格 Token 列的会话状态徽章变回"会话内"

**错误处理**
- [ ] daemon 关闭时，列表加载失败显示重试按钮
- [ ] session 过期时（401）跳登录页（除测试请求外）
- [ ] 测试请求 401 不跳登录页，显示在行内状态条

## 11. 待定问题

- **URL host 可配置**：v1 硬编码 `http://127.0.0.1:7410`。未来如需通过 `GET /api/agent-compose/config/daemon` 查询实际监听地址再扩展
- **Provider / Signature 字段暴露**：v1 固定 generic + none。如需支持 GitHub/GitLab 签名验证，需扩展 Modal 增加字段，并改 PUT body
- **实时请求日志**：v1 不做。如后端补 audit log（记录所有请求包括 401/404/413），UI 可在表格下方加 live log 卡片，复用 `store.events` 状态
- **多 tab 同步**：v1 不做。如需同步，可用 BroadcastChannel 或 polling + version 字段
- **`provider` 字段语义**：v1 固定 `'generic'`，但后端 `ProviderFromTopic(topic)` 会从 topic 第二段反推 provider（如 `webhook.github.push` -> `github`）。UI 是否需要展示这个反推值？v1 不展示，避免与固定 `'generic'` 产生认知冲突
