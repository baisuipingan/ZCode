# 账号钱包：影响说明与验收场景

2026-11-11；配套 [行为 spec](09-account-wallet-spec.md)。初始模式 `planning`；W1/W2实现及验收增补见11。本文件记录已确认需求、建议规则、实现前证据及待跑场景，不宣称当前运行版已经覆盖。

## Feature Summary

| 项目      | 内容                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| 需求      | 自有账号、sub2api 权威余额、加载同步、⟳手动同步、客户端充值                                                                 |
| 能力/层级 | account / wallet / recharge；presentation、validation、commit-effect、persistence、recovery                                 |
| 主要种子  | `WorkspaceSidebarFooter`、`WelcomeScreen`、`createLocalServices`、OAuth/Credential contracts、sub2api auth/payment handlers |
| 范围外    | 删除功能、重写 Agent、真实支付、后端部署；模型自动配置另切片，不影响W1/W2                                                   |

## UI Surface Matrix

| 用户场景/入口    | 共享实现                                  | 展示/草稿owner；来源              | 校验/动作                                       | 权威/持久化                   | 模式/隔离                                           |
| ---------------- | ----------------------------------------- | --------------------------------- | ----------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| 欢迎页登录       | WelcomeScreen外壳、窗控、现有input/button | UI只持邮箱/密码/challenge草稿     | 品牌Account facade；安全策略来自public settings | sub2api登录；私有repo保存pair | Desktop本机；不能写旧provider family或把token交远端 |
| 侧栏看余额/⟳     | Footer、Avatar、Tooltip、Button           | 同一wallet投影；组件不另fetch     | refreshBalance(reason=manual/load)              | sub2api me；本地epoch隔离缓存 | 项目侧栏/设置同源；换workspace不换钱包              |
| 账号页           | SettingsPage、新AccountSection            | 资料/余额投影；记录分页UI局部     | 每次进入同步；本人订单查询                      | sub2api user/payment          | baseServices；不随远程source切换                    |
| 充值弹窗         | Dialog、金额输入、支付展示壳              | UI持金额/方式/当前订单ID          | 确认后POST；订单查询/受限verify                 | sub2api订单与履约；只缓存ID   | 关闭不等于取消；不同账号不共享订单                  |
| 登录过期/退出    | Root生命周期/安全错误提示                 | 账户服务投影；UI只触发动作        | 自动refresh一次/退出                            | 私有epoch+pair；sub2api撤销   | 所有窗口一致退出；不删成果、不自动重放任务          |
| 余额不足（后续） | ChatErrorBanner/SessionPane               | 网关错误+wallet；不可用旧余额推断 | 打开同一充值弹窗；到账后用户继续                | runtime执行事实仍原owner      | 不将429当余额不足，不回退官方模型                   |

## Shared And Divergent Behavior

| 关注点      | 共享                                      | 必须区分                                             |
| ----------- | ----------------------------------------- | ---------------------------------------------------- |
| 视觉        | 现有紧凑布局、窗控、组件/深浅主题         | 账号/货币余额不借用套餐token桶                       |
| 来源/默认值 | 所有入口同一Account/Wallet契约            | UI金额草稿、钱包服务器快照、订单服务器状态是三类事实 |
| 校验        | 当前epoch/本人权限/安全错误映射           | 登录401、推理Key401、限流、充值中和同步失败分别处理  |
| 提交        | 所有充值入口同一服务                      | 手动余额刷新不会verify支付；查询支付不会本地加余额   |
| 持久化恢复  | 同一私有pair与account epoch；订单本人列表 | 关闭窗口不logout；缓存命中不跳过load同步             |

## Feature Relationships（按风险排序）

| 级别           | 关系/检查理由                                                 | 当前证据                                                                                                                                 |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| must-inspect   | 欢迎页→旧provider-family守卫，不能新登录又被旧guard挡回       | `packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts:57`、`Root.tsx:1241`                                                     |
| must-inspect   | Footer→两个入口，需同改资料/余额/退出                         | `packages/ui/src/project-sidebar/index.tsx:333`、`SettingsPage.tsx:1663`                                                                 |
| must-inspect   | Root→旧套餐Provider，即使按钮隐藏仍拉官方套餐                 | `packages/ui/src/Root.tsx:176`、`settings/CodingPlanUpgradeDialogProvider.tsx:35`                                                        |
| must-inspect   | 原充值webview→官方origin/凭据注入/购买完成IPC                 | `packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx:164`、`:359`；不能只替URL                                                  |
| must-inspect   | window Host→账户刷新存储，实例内锁不覆盖其他窗口              | `packages/desktop/src/main/desktopWindowLifecycle.ts:145`、`:202`、`packages/desktop/src/host/index.ts:3880`                             |
| must-inspect   | Credential RPC→Renderer/mobile，不能保存新登录secret          | `packages/services/src/credential/credential.ts:11`、`packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts:31`                     |
| must-inspect   | TS服务接口→实际任意command，必须注册窄facade                  | `packages/rpc/src/proxy-channel.ts:85`；仅private/类型隐藏不构成访问控制                                                                 |
| should-inspect | RPC异常→可能携raw error给UI，需要新client边界脱敏             | `packages/rpc/src/channelServer.ts:136`、`logging-middleware.ts:34`                                                                      |
| should-inspect | 原营销/奖励/套餐错误CTA→可能引导官方账号购买                  | `packages/ui/src/components/marketing-touch/MarketingTouchProvider.tsx:161`、`rewards/RewardsProvider.tsx:47`、`ChatErrorBanner.tsx:324` |
| conditional    | 远程workspace→不应承载本机账户                                | `packages/desktop/src/host/remoteWorkspaceRpcContract.ts:22`；新服务不加入远程/手机合同                                                  |
| invariant-only | Agent runtime/accepted queue/成果→钱包不能成为另一个执行owner | `docs/agents/runtime-boundaries.md`；任务继续的改动留给W3                                                                                |
| evidence-only  | 原OAuth、套餐E2E只能参考，不能算新账户通过                    | `docs/testing/desktop-coding-plan-profile-usage-navigation-e2e.md`                                                                       |

上述旧入口是本阶段封闭品牌账户耦合的检查清单，不授权物理删除用户决定保留的功能。自动化、Bots、远程等仍保留原代码；只有品牌账户相关入口按当前模式路由，不能把它们的官方auth偷偷绑定钱包。

## State Owners And Commit Sinks

| 状态                    | authority             | UI/缓存                 | 变更入口                                                   |
| ----------------------- | --------------------- | ----------------------- | ---------------------------------------------------------- |
| user/余额/冻结/订单     | sub2api               | 无secret投影、fetchedAt | AccountWalletService / RechargeService读取；服务端履约记账 |
| pair/epoch/tokenVersion | 私有AccountSecretRepo | UI仅登录状态            | Host AccountSessionService；原子pair+跨Hostrefresh锁       |
| 余额本地generation      | 每Host WalletService  | 侧栏/设置同一投影       | 单flight+forced invalidation；COMPLETED之后新读            |
| 表单/弹窗               | Renderer局部          | 可取消草稿              | hook→service command；不产生第二份余额                     |

跨窗默认方案：余额不向其他窗口广播为权威数据，只广播 `balance-invalidated{accountEpoch,reason}`。接收方重读本机私有epoch并自行拉取；广播可被Renderer发出，因此仅当提示。返回时重读epoch、检查本Host generation；在新强制事件发生后先递增generation，再等待/取消旧读，最后排新读。不同窗口可能短暂显示各自上次读取时间的余额，恢复焦点再同步；没有服务端账本revision时不声称严格一致。

## Must-Preserve Invariants

| 不变量                              | 必需证据                                                     |
| ----------------------------------- | ------------------------------------------------------------ |
| 客户端从不增减余额                  | 对账fixture余额不同于实付/缓存差，UI仍只展示me结果           |
| load/manual都产生新读，途中重复合并 | 网络记录+UI按钮状态；不是只检查mock函数被调用                |
| 旧epoch/generation不能回写          | 可控延迟A响应，在B登录/新查询之后释放，检查UI/secret repo    |
| token不进Renderer/CLI/URL/日志      | RPC/schema、网络、日志、持久化检查；新facade不暴露secret方法 |
| 刷新pair跨窗口原子轮转              | 两Host同时401/refresh，后端旧refresh只消费一次；锁超时不绕过 |
| 付款/入账/余额读取分开              | PAID→RECHARGING→COMPLETED与me的完整可控序列                  |
| 账号切换不删本地文件/任务           | 文件hash/历史索引/未发送草稿+UI运行场景                      |

## Codegraph Evidence

当前工具目录没有可用 codegraph 工具；未生成调用图结果。使用 `rg` 与逐段源码阅读追踪直接调用，默认语义一跳、代码约两层，跨窗/支付认证边界扩展到关键sink。查询工具缺失不阻塞设计，但以下是人工核实路径，不能冒充 codegraph 输出。

| 种子           | 直接路径                                                                    | 深度/结论                                       |
| -------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Footer         | project-sidebar / SettingsPage → Footer → useOAuth/套餐用量hook             | 2，共享展示与官方业务须分离                     |
| WelcomeScreen  | Root → WelcomeScreen/useOAuth → OAuthService；Root guard另读family/provider | 2–3，入口与门禁都需改                           |
| 充值           | Root → CodingPlanProvider → inventory hooks；Dialog → webview/preload       | 2–3，协议专用，不复用token注入                  |
| local services | desktopWindowLifecycle → window Host → createLocalServices                  | 2，每Host实例而非全局单例                       |
| sub2api订单    | routes/payment → PaymentHandler → payment fulfillment                       | 2，COMPLETED后才到账；handler DTO优先于前端声明 |

## Graph Drift Candidates / Graph Delta

语义图 `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` 当前没有品牌钱包关系。建议增加 `capability.brand-account-wallet`、欢迎登录/侧栏钱包/账户页/充值四个surface、sub2api权威owner、private repo owner、客户端不得本地记账的invariant。

这是新产品规划而非现有图谱错误；本轮在这里保存 proposed delta，待方案成为实现基线时写入图谱并校验 seed/完整性。新模块尚未存在，不编造代码seed，也不为本轮设计改动受治理的产品代码或图谱事实。

## Clarification Log / Boundary Decisions

| 来源     | 已确定                                                       | 方案/未决                                            |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| 用户本轮 | 自有账号和sub2api余额、每次加载+手动同步、桌面充值           | 余额不能本地记账为约束；刷新按钮具体状态由本spec推荐 |
| 用户此前 | 不删除功能、保留成熟Agent、零配置普通用户、Win/mac           | 本阶段保留代码，品牌入口装配替换                     |
| 当前源码 | 现有账号/余额/payment路由可复用                              | 线上URL、安全验证策略、渠道可用性待联调              |
| 推荐     | 一个当前账号跨窗口、native充值dialog、系统浏览器完成必要支付 | 无需为设计暂停等品牌名；不代用户选择真实金额或下单   |

## Dimensions / High-Risk Cross-Products

主域为 auth 生命周期、wallet 同步、recharge 履约、Desktop 跨窗口。选取 auth(未登录/有效/401可刷新/确认过期)、wallet(无值/同步中/新值/旧值失败)、order(待付/已付未到账/已完成/异常)、event(load/manual/focus/complete/logout)、Host(单/双)、网络(成功/断开/延迟)；不做全组合枚举。

## Candidate Combinations / Pruning Decisions

| ID  | 组合/处置                                        | 原因与代表覆盖                                    |
| --- | ------------------------------------------------ | ------------------------------------------------- |
| P1  | 单Host侧栏/设置/充值共用钱包：accepted           | 同一投影，无需三套不同记账规则；AW02/AW04         |
| P2  | Windows/macOS×明暗×键盘×窄窗：accepted代表组合   | 功能合同相同，覆盖窗控和可访问性；AW18            |
| P3  | 余额缓存有效就不发load请求：pruned               | 与用户每次加载同步冲突；AW03                      |
| P4  | pay callback/浏览器返回就加余额：pruned          | 与服务端权威及履约状态冲突；AW13/AW14             |
| P5  | 多账号每窗独立/远端Host存本机token：pruned       | 首片共享本机账号与安全边界；AW09/AW10             |
| P6  | 任意第三方支付SDK/移动JSAPI都原生支持：undefined | 需部署渠道/桌面适配合同；AW16显式不支持而非伪成功 |
| P7  | Agent登录后立即可执行：deferred                  | 本次W1/W2无推理bootstrap；W3按05/06验证           |

## Accepted Cases / Coverage Matrix

下表保留最初接受的目标合同；具体已运行子场景与未覆盖部分见文末实施增补，不能将单个子场景通过视为整行覆盖。每例需 UI + 网络/服务/文件至少两类证据；不写已退役 App业务单测。

| ID   | Setup / Action                                       | Assertions                                                       | 证据/层                           |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- |
| AW01 | 有效测试账号登录，分别有/无2FA                       | 完成当前安全验证；私有pair保存；本人信息出现；不见API Key配置    | Desktop E2E+本地假控制面/秘密扫描 |
| AW02 | me给定余额；侧栏与账户同时挂载                       | 同一金额、币种、更新时间和loading；同Host只发一读                | E2E+网络                          |
| AW03 | 有旧缓存，关闭重启/新窗口/两次进入账户/充值页        | 每次语义加载均读取；缓存只占位，失败明确陈旧                     | E2E+请求时间线                    |
| AW04 | 连点侧栏/设置⟳；服务端余额保持不变后再改变           | 在途合并，箭头旋转、可访问名；成功即更新读取时间；下次点击必发读 | 浏览器+网络                       |
| AW05 | 首次读取失败 / 旧余额后断网                          | 首次为—，旧值标待同步；非0；时间不更新；恢复可读                 | E2E+可控网络                      |
| AW06 | 返回USD/CNY公开配置、冻结、零/负数、小额及大整数边界 | 展示符合配置；冻结不重复减；负值不吞为0；不越界失真              | 工程/CLI解析器回归+UI fixture     |
| AW07 | 两Host同时access过期且refresh轮转                    | 一次旧refresh被消费，原子pair，双窗恢复；网络错误不清pair        | 双Host运行场景+假后端计数+repo    |
| AW08 | refresh超时 / 锁等待超时 / 确认过期                  | 不绕锁、不无限换证；可重试/重登；安全错误无secret                | 工程回归+运行场景+日志            |
| AW09 | A的me/refresh/订单响应延迟，退出后登录B再释放        | 不复活A、不串余额/订单/凭据；双窗投影均账号正确                  | E2E+repo与网络                    |
| AW10 | 切远程workspace / 关一个窗口 / 另窗保留              | 钱包仍本机；token不进远端/mobile；关窗不logout；无残留监听       | E2E+RPC/进程检查                  |
| AW11 | 不同限额/费率/赠送/关闭充值配置                      | 仅可用方式；金额验证；付款币种/预计到账分别标；无后台下单        | 浏览器+配置fixture                |
| AW12 | 确认充值连点 / POST超时                              | 正常只一次POST；未知结果先查本人订单，不自动重复建单             | E2E+假控制面                      |
| AW13 | 订单PENDING→PAID→RECHARGING→COMPLETED                | 前三态不宣称到账；COMPLETED后新me；不自增余额                    | E2E+可控履约事件                  |
| AW14 | 入账前me仍在途，COMPLETED后到账余额不同于实付        | 失效旧读并排新读；最后只显示新me，金额不自己相加                 | 并发时序E2E+请求generation        |
| AW15 | 已付关闭/重启 / 取消竞态 / 退款状态 / 再登录本人     | 订单从本人列表恢复；关闭不取消；状态服务端决定；不自动重付       | E2E+订单fixture                   |
| AW16 | qr_code、HTTPS pay_url、坏URL、Stripe/JSAPI特殊形态  | 已验证形态可用；坏域/scheme拒绝；未适配形态明确提示；无token注入 | 浏览器+平台mock；无真实付款       |
| AW17 | 到账成功但me失败；随后手动⟳成功                      | 分别显示已到账/余额待同步；旧值不增；成功显示真实新值            | E2E+网络                          |
| AW18 | Win/mac，深浅主题、窄窗口、键盘/reduced motion       | 原生窗控可达；余额与⟳独立；焦点/状态播报可用；旋转尊重系统       | 两平台浏览器/桌面视觉验收         |
| AW19 | 品牌模式启动、开账户/充值、过期、退出、余额不足入口  | 无旧账户/套餐/奖励官方请求；原功能代码保留；不静默启官方模型     | 请求目的地记录+场景验收           |

## Planning Handoff / E2E Notes

| 交接项                  | 状态                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| feature spec            | 已保存09；推荐行为待实施时冻结                                        |
| case catalog / coverage | 本文AW01–AW19；planned                                                |
| decision backlog        | 线上origin/币种/登录验证/支付渠道；特殊支付SDK与模型bootstrap分别立项 |
| E2E接入                 | 实施前用 `e2e-case-lifecycle` 维护当前工程入口；本轮未创建E2E代码     |

fixture用本机可控sub2api假控制面，返回脱敏固定账号与金额；真实测试部署仅验证授权账号，不真实付款。用闸门释放请求/履约事件控制时序，不靠sleep猜正确。跨窗开两个window Host；文件夹使用独立 `.zcode-runtime` 根；token泄露检查覆盖RPC/日志/URL/Renderer存储。支付使用模拟provider回调/测试渠道完成；不借“测试”名义向生产支付商真实下单。

## 本轮验证记录

- 源码证据：三线只读复核；sub2api工作区未修改；没有发起支付或登录请求。
- 产品实现与产品E2E：未执行，本轮是设计/原型。
- `pnpm typecheck`：通过（退出0，使用锁定Node24.14.0与已安装依赖）。
- `pnpm lint`：退出0，0 errors、84 warnings，警告位于现有产品/工程源码；未为本次文档工作修改这些源码。不是零警告。
- 原型：内嵌脚本 `node --check` 通过；本机HTTP返回200。浏览器检查登录/资料、充值选择/订单等待、支付确认不改余额、模拟服务端到账后新读、断网旧值+待同步、登录过期状态。已检查默认窄视口与1200×900桌面布局、深浅主题；截图见 `prototypes/account-wallet-preview.jpg`。仅验证原型，未验证真实接口。

## W1/W2实施验收增补（2026-11-11）

实现已落地，证据索引见 [11实施记录](11-account-wallet-implementation.md)。原生通过产物：`packages/desktop/.e2e-artifacts/brand-account-1794376962458`（N）；运行时与Host边界：`packages/desktop/.e2e-artifacts/brand-account-runtime-2026-11-11`（R）。用例仍在 manual-review/pending，尚未人工推广或加入CI。

| 场景             | 当前证据                                                                                  | 未覆盖部分                                |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| AW01             | partial：N密码登录，R两阶段challenge/验证码                                               | 原生2FA、安全挑战交互                     |
| AW02–04          | partial：N侧栏/账号余额、手动新读、打开充值/重启新读                                      | 完整加载/连点组合、双原生窗口             |
| AW05–06          | partial：N读取失败保留旧值、USD/CNY切换、冻结额不再扣减                                   | 首次无值失败、负值/极小值等完整金额边界   |
| AW07             | covered于runtime：R两个独立子Host并发401、旧refresh仅一次消费、pair原子保存；N单窗401恢复 | 双原生窗口视觉验收另记                    |
| AW08             | partial：R真实10秒超时后明确重登、429后允许稍后重试                                       | 锁等待超时、所有撤销/过期组合             |
| AW09             | partial：R迟到me/refresh与换号、自动跨Host退出；N显式退出                                 | 迟到订单与原生双窗组合                    |
| AW10             | partial：R窄facade与mobile不暴露、N OS密文/重启不退出/秘密哨兵检查                        | 真实远程workspace往返、所有销毁监听组合   |
| AW11–12          | partial：N后端渠道/范围、一次POST、禁用充值，R禁用仍读历史                                | POST结果未知、连点和更多限额边界          |
| AW13             | covered于本机原生fixture：N完整四态，到账余额使用me权威值                                 | 真正支付商回调未触发                      |
| AW14             | covered于runtime：R旧me在途，COMPLETED后排新me且旧响应不覆盖                              | 原生受控时序尚未跑                        |
| AW15–16          | partial：N重启恢复/关闭不取消、二维码与HTTPS动作，R缺币种详情补齐/不支持形态              | 取消竞态/退款/所有支付商/坏URL交互        |
| AW17             | partial：服务实现分离已到账与余额同步失败                                                 | 原生UI完整故障流程未运行                  |
| AW18             | partial：N macOS默认深色、原生窗控和键盘输入                                              | Windows、浅色/窄屏/reduced motion完整矩阵 |
| AW19             | partial：N品牌入口与无账户业务HTTP外呼，源码禁用旧OAuth/套餐/奖励/营销生产者              | 打包版所有Node/动态插件外呼、完整过期组合 |
| AW20（实施新增） | covered于Host边界：R5场景/85请求断言，UI显示禁发提示                                      | 原生绕过UI调用与后台调度另验；W3尚未接线  |

“covered于runtime/fixture”限定证据层，不宣称生产支付、双平台发行或全部交互通过。后续每次扩展应补对应层断言及真实产物，再提升该层状态。
