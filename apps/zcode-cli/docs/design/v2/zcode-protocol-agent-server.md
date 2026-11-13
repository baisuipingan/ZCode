# ZCode Protocol Agent Server

## 背景

z-code 桌面端后续不再通过 ZCode app-server 兼容多 agent，而是只把 zcode-cli 作为私有 agent server 集成。桌面、SSH、Docker 场景里，GUI/host process 需要以薄客户端方式连接 zcode-cli，由 server 统一持有 session、模型、思考深度、模式、消息和运行态。

## 范围

- 新增 `zcode app-server --stdio` 入口，输出只承载 ZCode Protocol NDJSON frame。
- `agent-server --stdio` 作为同一能力的别名，方便后续命名切换。
- ZCode Protocol schema 仍由外层 z-code workspace 的 `packages/shared/src/zcode-protocol/index.ts` 单文件导出。
- v1 只实现 stdio transport；WebSocket 留给 cloud IDE/remote sandbox 后续复用同一 envelope。

## 状态归属

### 品牌托管模型（W3）

受信本机 Host 仍通过 `provider/updateAccountConfig` 更新唯一 Account source；可选
`managedPolicy` 是独立于 Personal/官方账号的非秘密策略。存在该策略时，Registry 只发布
策略中的单个 Responses 模型；blocked 策略发布空集合，不借用 Personal、环境变量或官方配置。
更新回执的 `appliedRevision` / `managedReady` 只在 Registry 已实际应用同一 revision、且完整默认
selection 校验成功后返回，`receivedRevision` 本身不构成执行授权。

```text
Host bootstrap → Account source → Registry 原子应用 → applied 回执
                     ↓
CLI 唯一 admission → 冻结非秘密 billingBinding → queue/turn/child/auxiliary
                     ↓
每物理 attempt → Host 私有 resolver 核对原账户/epoch/policy → 本次动态 Key
```

`brand-managed` Access 只保存 credentialRef 和 billingBinding，不包含 Key/JWT。
反向 runtime headers 的 managedAccess 与原 accountAccess 互斥；缺 resolver、缺 binding、过期策略
在发送前失败。Key 只用于本次请求，清除静态认证头，禁止环境 Key 回退。Host 是秘密 owner，
CLI 是已接受输入与运行 owner，不新增 Host 队列。绑定包含 origin/accountRef/accountEpoch/policyRevision，
由已应用的受信策略注入；队列与 transcript 只保存该非秘密事实。换号不能重写已接受 intent，
旧 binding 请求失败；历史缺 binding 可只读恢复，不能自动执行。主任务、标题、压缩、记忆、
验证、子代理均继承其所属执行的原绑定，后台工作不得读取后来的账号作为扣费身份。
策略切换为 blocked、换号、epoch 或策略 revision 变化时，配置入口先关闭旧 resident runtime
的执行准入并沿既有 session lifecycle 关闭链取消前台、工具、子代理和 sidecar，再确认新 Registry。
持久输入与队列原事实保留；冷恢复只读，旧队列提升及 retry/edit 在写入或 reserve 前核对原绑定，
缺失或不匹配即拒绝，不给旧输入换上新账户/策略授权。相同策略重交不打断当前运行。

绑定作为既有 JSON intent 的加法可选字段，由 CLI codec/hydration 处理；不由 Host 直写 SQLite。
独立 CLI 和未接入品牌策略的远端保持原行为。验收使用 CLI schema/Registry/adapter/mock gateway
回归，不触发真实付费推理。

### 托管请求的私有结果反馈

`interaction/managedInferenceOutcome` 是当前本机 CLI 到本机 Host 的严格校验实时通知。
它只包含 workspace/session 路由和 `turn_settled` 的原 billingBinding，或结构化鉴权/余额
拒绝候选的原 managedAccess 与实际使用 Key 的 SHA-256 指纹。原始 Key、错误响应与正文
不进入通知；该通知不转发 Renderer，不入 transcript、持久事件或手机 replay/gap repair。
子代理复用既有父会话路由，保留原扣费归属；Host 拒绝旧进程、远端 workspace 和过期绑定。

401 + `INVALID_API_KEY`/`API_KEY_DISABLED` 只能作为候选，不能证明拒绝来自本机网关；
Host 匹配完整 scope、epoch、credentialRef 和当前指纹后合并一次强制 bootstrap，由控制面
决定是否换材料或阻断；不清登录、不恢复已停用 Key、不自动重放付费请求。403 +
`INSUFFICIENT_BALANCE` 仅提示权威余额/用量刷新。每个原 turn 的 finally 对成功、失败和取消
发结算信号，不能逐 token 或 tool step 刷新钱包；在途旧读取必须尾随一次事件后的新读取。

插件 `plugins/referenceCatalog` 与 `plugins/referenceCatalogWithCategory` 沿现有 listing join
按完整 plugin ID 投影可选 `description` / `descriptionI18n`。字段仅用于 Picker 按语言展示描述，
不进入 Session 冻结的能力身份或 model-only reminder；旧 Host 缺字段时 UI 留空。
语言回退与验收规则见[Plugin 对话引用](../../../../../docs/plugin-reference-mention.md#2-已确认的四项产品决策)。

- server 负责维护 session 核心状态：当前模型、可选模型、上次模型、思考深度、模式、权限、projection、eventSeq、stateRevision、消息和事件。
- TUI/GUI 只维护展示偏好，例如滚动位置、焦点、面板折叠状态和未提交草稿。
- `session/subscribe` 返回订阅确认、缺口事件和可选 snapshot；client 不把这层包装误当成 snapshot。

## 入口链路

```txt
zcode app-server --stdio
  -> runZCodeProtocolAgent
  -> ZCodeProtocolNdjsonConnection
  -> ZCodeProtocolAgentServer
  -> createZCodeApp / AgentRuntime / SessionStore
```

## stdio 输出边界

`app-server --stdio` 与 `agent-server --stdio` 的 stdout 是严格的 ZCode Protocol NDJSON
帧通道，不是通用日志流。宿主继续对每个非空 stdout 行执行严格的 schema
解析；不得为了兼容污染而忽略非 JSON 行。

CLI 在识别出 stdio protocol 命令后，必须在加载 `run.ts`、bootstrap 与三方 SDK
之前安装进程级 console 边界：`console.log/info/warn/debug/error` 统一写入 stderr，
只有协议 output 才允许写入 stdout（包括启动存储状态帧）。进程退出前保持该边界；
独立装配测试通过 disposer 恢复原 console。入口与 run 复用参数定义，只根据实际命令
启用生命周期，不能将 prompt/cwd 等选项的值误识别为 app-server。

```txt
ZCodeProtocolNdjsonConnection -> stdout -> Host JSON/schema parser
console.* / dependency logs    -> stderr -> Host log collector
```

该边界同时适用于桌面本地与 SSH/WSL/Docker 远程 agent；它不改变 protocol
message、desktop continuous 或 web remote replayable 的交付语义。

## 协议进程生命周期

CLI 入口在第一次异步初始化前接管 stdin/stdout 和信号，拥有唯一 shutdown deadline。
启动时用有背压的输入缓冲接住协议字节，不能为了观察 EOF 丢弃请求。bootstrap 通过
`RunZCodeProtocolAgentOptions.lifecycle` 接收取消信号、发起退出并读取同一个绝对 deadline；
它只释放运行时资源，不决定进程退出码。`--prepare-storage` Worker 和 plugin-host 保持各自生命周期。

```mermaid
stateDiagram-v2
  [*] --> starting
  starting --> serving: 初始化完成
  starting --> draining: stdin EOF
  serving --> draining: stdin EOF
  draining --> stopping: 已接收请求完成或 100ms drain 到期
  starting --> stopping: stdin/stdout 错误、信号、未捕获异常
  serving --> stopping: stdin/stdout 错误、信号、未捕获异常
  stopping --> exited: 清理和输出 flush 完成，或首次关闭起 1500ms 到期
```

- EOF 停止接单；有限的已接收请求可完成响应，挂起 handler 不能无限延长退出。
  首次关闭锁定原因、退出码和 deadline；后来的 SIGTERM、EOF、error 不重置预算。
- 仅 stderr 错误不关闭健康协议。入口对真实 stderr 安装写入边界：同步 throw、异步 error
  都只将出口置为不可用，之后不再写该流，不递归上报写入失败；所有 console/诊断共享该边界。
- 已被业务层处理的模型、工具、请求错误保留原协议行为。到达进程边界的未知
  uncaughtException/unhandledRejection 只诊断一次，随后取消运行、清理并以非零码退出。
- server 先拒绝新请求、取消反向请求和操作，再关闭所有已创建的 app，最后释放 gateway。
  迟到的 app 创建也必须关闭。此路径不调用产品 session/close，不发 session.removed，不删持久会话。
  bootstrap 在同一剩余预算内关闭 sampler、MCP/broker、共享存储、Registry 和遥测；单项失败不能阻止其他项被尝试。
- Host 立即使旧协议失效，但 stderr 保持收集至流关闭或有界 drain；exit 报告在 drain 后
  绑定原 runtime 身份与首次原因。正常 EOF 宽限 1800ms，进程树强杀仍受原总预算约束。
  CLI 的 E2E coverage 可额外预留 500ms 写盘，Host 沿用 coverage EOF 窗口。
- Host 按既有按需机制创建新 generation，不自动重发用户命令。手机 attachment 断开
  不触发共享 CLI 退出；desktop continuous / mobile replayable 的 owner 和恢复语义不变。

验收包括真实断管不自激、仅 stderr 断开仍能响应、启动中/空闲/在途 EOF、未知异常和
重复信号有界退出、短请求半关闭响应、挂起与迟到 handler 清理、最后一行诊断收集。

## v1 方法

- session: `create`、`resume`、`list`、`read`、`messages`、`events`、`subscribe`、`send`、`stop`、`setModel`、`setThoughtLevel`、`setMode`、`close`
- workspace: `readState`
- process: `childProcesses`——返回 MCP tracker 内存里仍有存活进程的 MCP 子进程 `{ pid, serverName, mcpSource, pluginName? }`。纯内存、无 I/O；`pluginName` 来自 `plugin:<name>:<key>` 命名空间，官方插件由 host CLI 注入的 MCP（如 `node_repl`）按 `OFFICIAL_PLUGIN_DEFINITIONS.hostMcpServerNames` 反查。桌面资源管理器用它把 Host 侧 `ps` 进程树上的 pid 归到内置 / 社区插件（见桌面仓库 `docs/electron/resource-manager.md`），CPU/内存采样不在 CLI 内完成。
- blocking request: 后续由 `interaction/requestPermission`、`interaction/requestUserInput` 通过 server-to-client request 扩展

## 验证

### 桌面字节码试验的启动约定

- `ZCODE_DESKTOP_AGENT_BYTECODE=1` 是 Dev desktop 启动器传给 Host 的实验开关，默认关闭；
  普通 Dev 启动显式关闭，`pnpm dev:desktop:bytecode` 显式开启。不开启时忽略残留字节码。
- 仅 Electron 的工作区 dist 解析路径选择同目录 `zcode.bytecode.cjs`；显式
  `ZCODE_AGENT_SERVER_COMMAND` 保持最高优先级，非 Electron/远端保持原入口。
- 开启后字节码入口缺失直接报错；禁止回退到 JS，避免 A/B 数据失真。
- `app-server --stdio`、`--surface`、cwd、stdin EOF、stdout 帧以及 stderr 诊断契约不变。
  `storagePreparationEntry` 仍指向普通 `zcode.cjs`，不改变 Host Worker 的准备协议。
- 字节码绑定生成时的 Electron/Node/V8、平台/架构和 V8 缓存标识，升级后必须重建。
  coverage 构建与字节码试验互斥；完整构建/测量边界见
  [桌面打包文档](../../../../../docs/electron/desktop-bundle.md#桌面-stdio-agent-字节码试验)。

- bootstrap 单元测试覆盖 create/read/subscribe 的返回形态，以及 server-owned model state mutation 的 `state.updated` 通知。
- CLI 单元测试覆盖 `app-server --stdio` 分发到 `runZCodeProtocolAgent`。
- CLI protocol 入口测试覆盖三方代码调用 `console.debug` 时 stdout 仍为空且日志进入 stderr，并验证命令结束后 console 恢复。
- 真实子进程回归使用不声明 `tools` capability 的 MCP server，约束 `mcp/list` 返回合法 JSON 且 transport 不出现 `protocol_parse_error`。
- app 联调烟测覆盖 `IZCodeAgentService.initialize()` 启动 stdio agent、`session/create` 返回 snapshot、`session/read` 读取同一 session。

### 扫码远控执行遥测来源

Host 在 V4 command envelope 注入可选 `inputOrigin=desktop|mobile`，CLI 复用 input intent
保存到各类新输入（首发、goal、edit/retry）；queue promotion 保留原 intent 来源。TurnStarted
遥测仅投影来源和无正文的运行配置，不传输入正文。历史 hydration/recovery 不生成遥测。
执行服务消费 live fact 收口远控 completion/step；手机 replayable 和桌面 continuous 的交付不变。

# 2026-11-12：受管目录在线更新与执行边界

Host 是账户、推理材料与目录同步的唯一所有者；CLI Registry 仅应用完整非秘密策略。目录 `revision` 是应用确认版本，`billingBinding.policyRevision` 从本版起表示稳定授权作用域（账号/epoch、凭据、网关与计费组），不随模型新增、展示名、默认值而变化。旧持久输入的原 binding 仍不改写。

- 同一登录账号下，目录及分组、凭据引用、网关变更只替换 Registry，不关闭 resident runtime、不取消已打开的流或本地工具。旧 Model 的下一 attempt 仍按原授权作用域/凭据引用核验，不得借新配置自动续授权；显式新轮使用新 Registry。退出、换号、账号 epoch 变化及 blocked 沿用取消屏障。
- 每次真实模型 attempt 的既有反向鉴权携带 `modelConfigRevision`，由共享 `managedModelConfigFingerprint` 对执行配置规范化得到；Host 将其与最新该模型配置比较。名称及推荐默认思考档位不属于指纹；实际允许档位、映射与能力仍属于指纹。已删除或参数不兼容模型在下一次请求被拒绝，其他模型继续工作；不撤回已打开请求，不自动换模型。
- `defaultSelection: null` 表示管理员默认暂不可用。ready 可有零个模型，此时应用成功但没有可执行选择；不得回落原官方供应商或按目录顺序猜默认。
- 在实际新需求/继续/队列提升准入前，CLI 通过现有 `interaction/requestProviderRuntimeHeaders` 发送 `phase: admission`。Host 按唯一 freshness 协调器等待同步及 CLI 应用确认；失败发生在账本接受或队列移除以前。普通 attempt 缺省 `phase: attempt`，只查当前授权，不因控制面暂时故障额外终止长任务。
- 新输入在 freshness 前只捕获登录账号身份（origin/accountRef/epoch），不提前冻结 scope。ACK 后先复核该身份未变，再首次冻结最新 billingBinding；同账号恰逢切组可以当次按新 scope 准入。已有 admission、队列、重试和历史输入仍比较完整原 binding，不因刷新迁移；换号或 epoch 变化在写账本前拒绝。
- 自动队列提升与显式发送共用准入路径、原 reservation/lease/CommandInbox；不建立第二 accepted queue。失败保留原队列项、原输入和成果。

```mermaid
sequenceDiagram
  participant Q as CLI CommandInbox/queue
  participant H as Host 目录 owner
  participant R as CLI Registry
  Q->>H: existing reverse RPC (phase admission)
  H->>H: same-account single-flight freshness
  H->>R: provider/updateAccountConfig
  R-->>H: appliedRevision + managedReady
  H-->>Q: headersApplied
  Q->>Q: bind original authorization; accept/start
  Q->>H: attempt auth + modelConfigRevision
  H-->>Q: current model credential or explicit rejection
```

回归：目录新增/展示名/默认不关闭 runtime；同账号切组/换凭据/网关不打断真实 HTTP SSE，但旧授权下一 attempt 被拦；推荐默认档位变化不影响既有合法档位；默认失效不替换用户选择；空目录 ACK；移除模型/改变能力的旧 Model 下一 attempt 被拦；账号变化仍取消；队列 freshness 失败原位保留，恢复后仅执行一次。
