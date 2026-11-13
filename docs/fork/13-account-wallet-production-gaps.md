# 账号与钱包生产化缺口

2026-11-11；仅方案与源码复查，不修改 sub2api，不执行部署、真实账号请求、建单或支付。
基线和既有验证见 [11：实施记录](11-account-wallet-implementation.md)；推理接线见 [12：受管 Agent 推理设计](12-managed-agent-inference-design.md)。
本文的新增接口、行为和验收均为 proposal / planned，不因已有 fixture 验收而自动变成已实现或已通过。
证据中的 `ZCode/` 指本仓库，`sub2api/` 指同级只读仓库；行号取本轮检出源码，后续变更需同步维护。

## 现有已实现

### W1/W2 应保留的边界

- 本机 Host 独立持有品牌登录、刷新材料、账户 epoch 和钱包事实；不写官方 UserInfo，不向远端 workspace 发送凭据。
- Renderer 只取得脱敏快照与命令接口；操作系统加密不可用时不降级为明文。
- 登录、2FA、刷新、本人资料与余额、充值配置、本人订单、核验均复用已有 sub2api API。
- 钱包余额来自 `/auth/me`；失败保留旧值并标为待同步，COMPLETED 后由服务重新读取，不按实付金额自行加余额。
- 多 Host 通过共享文件锁串行轮转；刷新结果不确定时保留材料但禁止重放旧 refresh，要求重新登录。
- 支持服务器返回的二维码和 HTTPS 支付链接；SDK、微信 OAuth/JSAPI 与浏览器安全挑战尚未适配。
- W3 未接通时 UI 与本机 Host admission 禁止新推理，历史读取、文件预览、导出和账户页保持可用。

证据：`ZCode/packages/services/src/brand-account/service.ts:152`（轮转）、`:241`（余额）、`:507`（到账后刷新）；
`ZCode/packages/services/src/brand-account/contract.ts:139`（脱敏服务接口），`projections.ts:131`（支付形态投影）。
既有 native/runtime/admission fixture 的实际覆盖与限制统一引用 11，不在本文复制为生产支付证明。

### 现有后端可直接继承

| 能力               | 当前源码证据                                                                                      | 生产化含义                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 验证码、密码及 2FA | `sub2api/backend/internal/handler/auth_handler.go:246`、`:264`；`service/auth_service.go:417`     | 后端校验可复用，桌面没有绕过资格                     |
| 登录刷新和本人资料 | `sub2api/backend/internal/server/routes/auth.go:38`、`:54`、`:257`                                | 不需要重建账号系统                                   |
| 本人充值订单及核验 | `sub2api/backend/internal/server/routes/payment.go:46`、`:53`                                     | 本人 JWT 控制面与推理 Key 分离                       |
| 服务端报价计算     | `sub2api/backend/internal/service/payment_order.go:56`；`payment_recharge_bonus.go:262`           | 赠送、折扣、换算、手续费继续由后端计算               |
| 历史金额快照       | `sub2api/backend/internal/service/payment_order.go:200`、`:232`；`ent/schema/payment_order.go:59` | 已保存 credits、汇率和 billing version，不需重做账本 |
| 到账防重复         | `sub2api/backend/internal/service/payment_fulfillment.go:448`                                     | 已有订单履约幂等，不等于创建请求幂等                 |
| 本人实际用量       | `sub2api/backend/internal/handler/usage_handler.go:70`；`handler/dto/types.go:634`                | 已有 Key 归属检查、actual_cost 与 charge_credits     |
| 会话关联标识       | `sub2api/backend/internal/service/session_id.go:35`；`handler/dto/types.go:675`                   | 已有协议通用 session_id，可作为任务关联基础          |

### 当前充值关闭与 W3 的关系

本轮既有公开配置核验为充值关闭；运行时仍以服务器最新配置为准，客户端不可自行开启。
充值关闭不阻塞 W3：有授权且已有可用余额的测试账户，可验证受管 Key → 默认模型 → 工具调用 → 真实用量记录。
该验证不得为了推进 W3 创建充值订单，也不能把“工具执行成功”当作“充值到账成功”。
本文不记录任何真实账户、余额、token、订单号或生产请求内容。

## 正式开放前需补

### P0-A：登录挑战的支持范围与浏览器交接

当前 UI 在验证码开关启用时禁用原生密码提交并给出网站入口；网页登录不会同步桌面。
证据：`ZCode/packages/ui/src/brand-account/BrandAccountLogin.tsx:23`、`:144`；服务端仍验证证明材料。
因此必须在发行说明中明确原生登录的支持范围，不能通过关闭服务端安全校验适配客户端。
若首发支持启用验证码的站点，建议增加 `/desktop/auth/start` 与 `/desktop/auth/exchange`，命名为 proposal。
浏览器在正规站点完成密码、挑战和 2FA；桌面使用短时一次性 code、state、PKCE 换取自己的 token pair。
授权码绑定发起客户端与固定回调；存储哈希、限制有效期、单次兑换，并校验拒绝/取消/超时。
登录 access token、refresh token、密码均不得进入 URL、日志、剪贴板或 Renderer 存储。
开发 loopback 与正式 deep link 回调分别登记白名单，不接受任意 return URL。
修改模块：sub2api auth handler/service/routes 与浏览器授权页；ZCode brand-account 服务、平台回调及登录 UI。
无需把已有第三方 OAuth 的上游 PKCE 流程误当成桌面授权服务；生产 WAF 是否另需浏览器挑战仍待授权验证。

### P0-B：建单请求幂等与不确定结果恢复

当前创建 DTO 没有客户端请求标识：`sub2api/backend/internal/handler/payment_handler.go:236`。
每次创建都会分配新交易号：`sub2api/backend/internal/service/payment_order.go:179`；不能只依赖禁用按钮。
Stripe 的 `pi-{OrderID}` 仅保护同一个已分配订单：`sub2api/backend/internal/payment/provider/stripe.go:129`。
建议扩展创建请求为稳定 `client_request_id`；数据库按 `(user_id, client_request_id)` 唯一约束。
同时保存规范化参数指纹，覆盖金额、币种/报价、渠道、order_type、plan、来源等计费相关字段。
同 ID 同参数返回同一订单和状态；同 ID 不同指纹返回明确冲突，不能复用旧支付金额。
并发创建、进程重启、响应丢失均从该记录恢复；客户端先持久化请求 ID，再提交 POST。
恢复只重新读取或续取同一订单的支付动作，不能偷偷新建替代订单；多次支付回调继续复用现有履约防重复。
修改模块：sub2api payment DTO/service/schema；ZCode brand-account 私有请求记录和充值对话框。
优先级：正式开放客户端建单前完成；当前充值关闭不阻塞先实施 W3。

### P0-C：下单前能力过滤及既有订单支付动作恢复

当前 `MethodLimits` 只有名称、币种、费率和限额：`sub2api/backend/internal/service/payment_config_service.go:133`。
支付宝/微信名称不能决定底层为 URL、二维码还是 Stripe SDK；前端硬编码名称过滤会误判。
建议 checkout-info 接受桌面能力或客户端版本，返回可执行 action 类型，并在服务器选渠道时再次约束。
首发可仅允许 `https_redirect` 与 `qr_code`，不要创建后才让用户发现该方式无法继续。
当前本人订单 DTO 不返回 pay_url/qr_code：`sub2api/backend/internal/handler/payment_handler.go:630`。
建议新增本人订单 resume/action 接口，校验 owner、状态、过期时间及原 provider 快照，只恢复同一订单。
底层已保存 pay_url/qr_code：`sub2api/backend/ent/schema/payment_order.go:84`；优先安全投影，避免再次调用创建。
SDK 如需首发，优先服务器托管 checkout session：短时票据绑定订单，系统浏览器加载支付 SDK，桌面查权威状态。
原站 Stripe 从同浏览器快照读取 secret：`sub2api/frontend/src/views/user/StripePaymentView.vue:137`；
Airwallex 同样要求 intent/secret：`sub2api/frontend/src/views/user/AirwallexPaymentView.vue:72`。
现有 signed resume lookup 只恢复订单状态：`sub2api/backend/internal/handler/payment_handler.go:591`，不能宣称可恢复 SDK。
修改模块：sub2api checkout-info/payment resume/托管页；ZCode checkout 投影与系统浏览器入口。

### P0-D：支付前核对、历史币种和实际消费的准确性

当前采用“创建订单 → 展示服务器金额 → 明确打开支付/扫码”，此路径可以保留，不在客户端复制报价算法。
支付金额按订单 currency 展示；充值额度和赠送当前明确显示 USD，不能套用今天汇率冒充历史本币到账。
证据：`ZCode/packages/ui/src/brand-account/BrandRechargeDialog.tsx:335`；`BrandAccountSection.tsx:170`。
后端历史快照已存在，但用户 DTO 未暴露：`sub2api/backend/internal/handler/payment_handler.go:630`。
如增加历史 credits/CNY 展示，只扩 DTO 与客户端合同，读取订单快照；历史数据缺失必须明示，不推算伪精确值。
开放 W3 的消费展示先按用户/Agent 专属 Key 查询现有 `/usage` 与 stats，普通 UI 不展示配置 Key 的概念。
证据：`sub2api/backend/internal/server/routes/user.go:129`；`handler/usage_handler.go:77` 校验 Key 属于本人。
credits 引擎以 charge_credits 对账，actual_cost 为 USD 等价报告值：`sub2api/backend/ent/schema/usage_log.go:117`。
现用量DTO将int64作为JSON number返回（`sub2api/backend/internal/handler/dto/types.go:640`）；推荐加兼容的credits十进制字符串字段并由Host/UI保留字符串，或Host对原始响应无损解析，不能先普通JSON.parse再转BigInt。
现有stats仅提供USD浮点报告汇总，不含精确credits合计；legacy正费用也可能charge_credits为0，应回退actual_cost USD，不能展示为免费。详12的消费合同。
不能把 total_cost（标准价）、token 估算、模型报价或余额差称作实际扣费；小额费用使用合适精度。
客户端新增受管 usage 查询投影及分页/同步时间，保留“待结算/记录延迟”状态；不在 Renderer 保存推理 Key。
修改模块：ZCode brand-account 服务合同/UI；sub2api 现有用量接口可先复用，无需先做任务级新账本。

## 可后置

- **独立 quote 接口**：下单前预览手续费/优惠；复用 `payment_order.go:56` 的算法，返回过期时间、配置版本及报价标识。
  创建时重验报价；配置变化要求重新确认，不把 quote 当锁价承诺。当前创建后核对金额已能避免客户端复制公式。
- **原生 SDK 与微信内支付**：托管浏览器方案稳定后再评估；不能把 client_secret/intent_id 当 URL，也不向浏览器注入账号 JWT。
- **历史快照完整 DTO**：补 credited_credits、bonus_credits、credits_per_usd、usd_to_cny、recharge_rate、billing_version。
  仅供真实历史展示和对账；保留现有订单的 USD 展示可先满足准确性。
- **任务/run 归属账单**：先贯通不含路径的 opaque task correlation ID，主请求、子 Agent、标题、压缩、记忆都遵守归属规则。
  现有 session_id 已入库，但 `sub2api/backend/internal/pkg/usagestats/usage_log_types.go:271` 没有 session 筛选与聚合。
  可先增加本人 session 过滤/索引/聚合；需要 run、父子关系和请求用途时再加明确字段，不用时间相近猜归属。
  完成前仅展示当前连接对应的Agent Key消费，不得展示“本任务花费”或把客户端 correlation 当鉴权依据。12首片采用每用户共享Agent Key，不能把Key汇总称为本设备消费；跨轮换完整历史还需按user+purpose包含旧Key查询。
- **体验扩展**：完整订单分页、取消/退款操作、注册找回原生化、Passkey、多支付渠道、消费导出；各自维护产品合同与场景。

## 新增验收提案

以下均为 **proposal / planned，尚未执行**；不替代 11 中已执行 fixture 的真实结果。
涉及支付商时先用沙箱和独立测试账户；真实支付或发布另需明确授权，本方案不授予执行权限。

| ID / 优先级 | Setup                                                            | Action                        | Assertion                                                                        | 状态     |
| ----------- | ---------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- | -------- |
| PG01 / P0-A | 启用一种验证码；独立桌面授权会话                                 | 浏览器挑战、2FA后兑换 code    | 桌面登录；URL/日志无登录 token；兑换仅一次                                       | planned  |
| PG02 / P0-A | 错误 state/verifier、过期 code、取消授权                         | 兑换或重放                    | 拒绝且旧账户不被新回包覆盖；可重新开始                                           | planned  |
| PG03 / P0-B | 同用户同 request ID/指纹；并发与响应丢失                         | 提交、重启后重试              | 仅一订单/一次上游建单；返回同订单                                                | planned  |
| PG04 / P0-B | 同 request ID 改金额/渠道；另一用户同 ID                         | 重试创建                      | 前者冲突；后者独立，无跨用户订单泄露                                             | planned  |
| PG05 / P0-C | 同名渠道切不同 provider；仅声明 URL/QR 能力                      | 读取 checkout-info 并创建     | 服务器过滤/拒绝不支持动作，不生成无法支付订单                                    | planned  |
| PG06 / P0-C | 待付 URL/QR 订单；关闭窗口/重启/换设备                           | 本人 resume                   | 同一订单动作恢复；已完成/过期不再放行；非本人拒绝                                | planned  |
| PG07 / P0-C | SDK 沙箱与托管票据；浏览器无原站快照                             | 系统浏览器支付并返回          | 不依赖旧 localStorage；桌面查询权威完成，回调重复不重复入账                      | planned  |
| PG08 / P0-D | 创建订单后修改公开币种/汇率与 billing version                    | 重读历史和钱包                | 历史按订单快照；实时钱包按当前规则，二者标识清晰                                 | planned  |
| PG09 / P0-D | 两用户、Agent/普通Key、不同费率、超安全整数credits、legacy及轮换 | 调用模型后查本人用量          | credits无损；legacy不误当免费；当前连接范围不冒充全历史；普通Key不混入；越权拒绝 | planned  |
| PG10 / W3   | 充值关闭；授权测试账户有已有余额                                 | bootstrap、工具调用、查 usage | 无订单创建；模型走受管凭据；真实用量记录可见                                     | planned  |
| PG11 / 后置 | 一个任务含子Agent/标题/压缩/记忆，另一任务并发                   | 查任务费用                    | 无漏记/串记/重复计入；待结算明确；无相关ID不猜归属                               | proposal |
| PG12 / 发行 | Windows/macOS干净机正式包；断网与OS存储故障                      | 登录/恢复/退出/支付恢复       | 平台加密与回调有效；失败可恢复，不降级明文或越权                                 | planned  |

## 建议推进顺序与未知项

1. 保留 W1/W2，按 12 完成 W3 受管推理与现有余额的真实工具调用验证，同时接 Key 维度实际消费。
2. 正式开放充值前落实 P0-B、P0-C，选定可支持的支付渠道，并做支付商沙箱端到端及到账恢复验收。
3. 按站点安全配置决定 P0-A 的交付门槛；验证码启用时，浏览器交接完成之前不能宣称零配置登录全覆盖。
4. 确认产品需要后再推进 quote、历史本币快照展示及任务级账单，避免扩大首条可验证切片。

尚未确定：生产WAF规则、各支付商的正式回跳/SDK限制、沙箱及渠道开关、正式包双平台行为和后台记账延迟。
源码说明能力存在不代表生产配置已启用；本文件只形成后续实施依据，不记录任何真实支付成功结论。
