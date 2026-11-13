# 哪些可以删：按产品价值和依赖排序的源码裁剪清单

日期：2026-11-11。基线仍为 `a9fe401eede6e6e5e01be9048679c206fe6f02d9`；本轮只读复核并更新文档，没有删除源码。产品范围沿用 [总览](README.md)：Windows/macOS、本地开发与四类办公，使用 sub2api 账号/余额。

**可以显著收窄维护范围，但应按功能调用链删除。** 先理解独立产品端、渠道和插件的用途，再选择关闭或删除；接通自有账号后替换厂商商业体系。Agent、工具、预览和恢复构成保留核心。以下是删除候选和前置条件，不是已批准或“已通过构建的安全删除列表”。

## 产品澄清：候选不等于没有价值

2026-11-11用户进一步明确：**不需要手机远控**；内部文档站、分享、Superpowers、Bots等先解释用途再决定。此前“优先删除”是基于首版范围的技术建议，不代表这些功能无用或已获删除授权。当前不执行删除；Bots与分享转为待产品选择，内部文档站建议在二开调查期先保留作开发工具，Superpowers先评估预置开发流程价值。

| 名称                            | 实际用途                                                                                                                 | 当前产品判断                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内部文档站 `apps/dev-docs`      | 开发者用的能力/依赖地图、协议字段浏览、Agent stdio通信检查；入口见 `apps/dev-docs/src/App.tsx:496`，不是普通用户帮助中心 | 不随桌面产品发行；二开期保留可能有助理解大库，无需为了不发行立即删源码                                                                                   |
| 独立分享站 `packages/web-share` | 浏览器查看分享会话、工具过程和允许公开的附件/成果；可按权限导入桌面新任务继续                                            | 有协作/传播价值，待选；依赖分享后端和存储，现有sub2api不等于已提供此业务。不同于本地文件导出、网站部署或实时共同编辑                                     |
| Superpowers                     | 第三方开发方法技能包：需求澄清、设计计划、调试、测试、审查与完成验证；manifest为5.1.0/MIT                                | 当前默认staging/SEA已移除，不代表不能安装使用或流程无价值；是否有等效替代无证据。首版可作为受管开发流程评估，别直接按废代码处理                          |
| Bots                            | 在微信/飞书/Lark/Telegram或Webhook中收任务、回复文本进度/摘要与审批，仍使用桌面同一执行器                                | 有办公渠道价值，待选；用户不需要手机网页远控，不自动等于不需要聊天渠道。需要本机运行、渠道身份配置与可信用户绑定；当前不承诺生成Office后自动发送成品附件 |

Bots实现清单以 `packages/services/src/bots/botsService.ts:825` 为准：上述5类有adapter；Discord/企业微信仍为null，不因类型或UI名称声称可用。群聊当前只放行飞书/Lark；入站附件有数量/大小限制，出站 `packages/shared/src/bots.ts:599` 的消息合同没有成果文件上传字段，不能承诺“生成PPT后把.pptx自动发微信”。

Superpowers的默认分发退出证据见下表。staging/SEA注释提到推荐按需安装，但 `packages/ui/src/settings/recommendedPlugins.ts:3` 又声明客户端策展推荐已下线；当前市场仍支持搜索/安装，不能据旧注释声称当前一定有Superpowers推荐入口，更不能认定已有等效新机制完整替代。这些是源码用途核对，不是功能运行验收。

## 1. 仓库看起来大的实际来源

本次按 `git ls-files` 的当前文件字节统计；MiB=1,048,576 字节，不含 `.git`、node_modules 和未跟踪构建物。目录占用 `du` 还含文件系统块/忽略文件，不能与下表混算。

| 内容                                    |   当前受跟踪文件实长 | 判断                                                         |
| --------------------------------------- | -------------------: | ------------------------------------------------------------ |
| `docs/electron`                         |            11.36 MiB | Electron文档镜像，不是Electron运行时                         |
| `docs/knip`                             |            10.38 MiB | Knip网站/文档镜像，含视频；不是knip工具本身                  |
| `docs/images`                           |            10.02 MiB | 12份说明图；可清旧品牌/不再保留功能的图片并维护引用          |
| `docs/webdriverio`                      |             0.72 MiB | 测试工具文档镜像；移除镜像不等于删除E2E能力                  |
| `packages/desktop/test`                 | 14.58 MiB，2,134文件 | 大量验收资产；随被裁功能删对应夹具，不能整目录清空           |
| `apps/zcode-cli/dependencies`           |    21.58 MiB，21文件 | 多平台搜索工具等固定归档；当前构建离线输入，不能当缓存直接删 |
| `packages/services/src/bots`            |     0.71 MiB，42文件 | 有明确产品裁剪价值，但不是仓库体积主体                       |
| `packages/services/src/marketing-touch` |    约0.01 MiB，3文件 | 价值在减少业务耦合与外呼，体积收益很小                       |

前三类镜像加图片、WebdriverIO镜像约 **32.48 MiB**，适合优先从主工作树移走/改外链；同步清理镜像归属及引用。这样会减轻当前检出目录，不会自动清掉 Git 历史，也不能推算桌面安装包等量减少。`third-party/copied-components.json:258`、`:270` 与 `inventory.json:265` 登记了 Knip镜像/字体材料，不能只删文件留下错误清单；`scripts/architecture/upstream-snapshot.json` 是上游基线，是否调整须遵守其admission策略，不为通过门禁随意重写。

## 2. 最优先考虑物理删除的内容

“删除”包括同步维护 workspace/锁文件/构建脚本/注册/声明/相关验收；不建议直接在文件管理器删目录。

| 候选                                                     | 为什么本产品不需要                                   | 删除前同步处理 / 当前证据                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/android`                                       | 独立Android手机远控壳，首版仅Windows/macOS           | Gradle工程与指向官方远控的默认配置 `app/build.gradle.kts:24`；未找到桌面运行时导入。清相关说明/资源与发布入口；它和Agent Android模拟器插件是两套模块                                                                                                                                                 |
| `apps/dev-docs`                                          | 内部开发文档站，不是用户功能                         | `scripts/licenses.mjs:116` 明确其不随产品分发。清 `pnpm-workspace.yaml:2`、根 `package.json:8`、`:37`、`:51` 的dev/build/typecheck引用，保留有价值的架构说明                                                                                                                                         |
| `packages/web-share` + `packages/share-ui`               | 独立公开分享站；首版不提供官方分享                   | 成组清独立分享脚本/构建守卫；`web-share/src/main.tsx:2` 使用share-ui。后者是重导出（`share-ui/src/index.ts:2`），别连带删 `packages/ui` 成果/消息组件；桌面分享服务另在下一表处理                                                                                                                    |
| `apps/zcode-cli/packages/superpowers-plugin`             | 已从内置插件发行下线                                 | desktop staging `packages/desktop/scripts/prepare-agent-node-bundle.mjs:279` 与SEA清单 `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs:229` 已注明退役；清推荐/翻译/归属引用。删它只减源码，不会再减当前默认打包资源；`docs/superpowers`含项目历史spec，不是同名插件的可整删附件 |
| `apps/zcode-cli/packages/restore-legacy-sessions-plugin` | 面向上游历史会话迁移，自有新产品无对应旧数据迁移承诺 | UI已有retired过滤（`packages/ui/src/settings/PluginStoreListView.tsx:29`），但desktop/SEA还stage其资产（`prepare-agent-node-bundle.mjs:225`、`sea-official-plugin-assets.mjs:176`），需同步删除注册/资源合同；保留普通会话恢复与数据库migration                                                      |
| 上述文档镜像、废弃截图                                   | 不属于桌面运行代码                                   | 外部资料改固定版本链接/独立文档仓；清Markdown引用、第三方复制清单。保留 `docs/fork`、架构策略、现行spec、测试/构建规范、AGENTS与许可文件                                                                                                                                                             |

这批大部分不依赖 sub2api 接口落地，适合作为首次裁剪的小PR；先建立可构建基线，逐项验证。Android/dev-docs/分享两包本身受跟踪源码合计不足0.5MiB，不要期待删它们就显著缩小安装包。

## 3. 可裁的业务链：先判断产品价值，再移除

| 功能 / 主要位置                                                                                   | 建议                                             | 必须保留或先迁出的边界                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 营销奖励：`packages/services/src/marketing-touch`、对应UI/rewards入口                             | **优先删除业务链**                               | 清 `packages/services/src/node.ts:58`、`:2696` 服务装配、`packages/shared/src/channels.ts:158`、UI事件与配置；`node.ts:2708`的CloudContent还消费marketingAssets，先换成空registry/自有来源；保留共享对话框、WebView、cloud-content和logger |
| Bots：`packages/services/src/bots`、Bot设置与通道                                                 | **首版删除候选**                                 | `packages/services/src/node.ts:2733`始终注册，本地还有startup tasks；清注册、第三方连接/轮询、消息准入、凭据类型、Bot专属测试/文档；保留通用会话、权限、附件、工具和账户secret存储                                                         |
| 官方站点发布：`apps/zcode-cli/packages/zcode-site-plugin`                                         | **停用后整链删除**                               | 当前默认启用；清插件/命令/面板、staging、构建检查、official-command-endpoint的Sites授权路径。其合同 `bootstrap/src/official-command-endpoint/contract.ts:9` 与转发 `endpoint.ts:140` 详见04；保留本地网站预览、文件导出                    |
| 官方图片搜索：`apps/zcode-cli/packages/image-search-plugin`                                       | **无自有适配时删发行资产/入口**                  | 依赖官方JWT，与图片生成无关；清默认插件集合、staging和UI图标。它源码仅约3.6KB，主要收益是消除官方认证依赖                                                                                                                                  |
| 官方会话分享：`packages/services/src/conversation-share`与桌面UI                                  | **分享关闭后移除专用链**                         | 先清服务注册/公开RPC/上传入口/分享导入；保留通用附件物化、预览、消息投影及本地导出所需消费者                                                                                                                                               |
| 高速卡/闲时票据：`packages/services/src/highspeed`、`session/offPeakServerClient.ts`和CLI专用分支 | **先禁用，受管模型接通后再审专用机制的物理删除** | 闲时票据深入scheduler的claim/dispatch/settle与tasks-index；别删历史数据库migration、通用模型requestAuth、CommandInbox、runtime readiness、重试与恢复；普通后台任务/定时器不是闲时票据同一能力                                              |
| 原套餐/团队/支付：`packages/services/src/coding-plan-subscription`内厂商实现、相关UI              | **由sub2api替换后裁**                            | 不能整目录直接删：service `codingPlanSubscriptionService.ts:51`、`:56`、`:61`、`:63`、`:64`还承载工作流、上下文预算、请求验证和版本策略；`node.ts:2279`、`:2287`注入Agent。先把仍需策略迁到品牌独立owner，再删除厂商商业adapter            |
| 官方登录/OAuth、项目Key、MCP权益、官方云配置                                                      | **新账号与托管凭据接通后替换**                   | 保留通用OAuth（如第三方MCP授权）、私有凭据、Provider和模型鉴权机制；替换原厂商实现。旧业务协议不同于sub2api，见05                                                                                                                          |

共同要求：停后台生产者，清注册/依赖而不是仅删页面；每次切除后跑既定登录/任务/恢复/办公/预览场景。删除Bots、营销和官方发布可先于完整充值UI，但应保持成熟执行主链可运行。团队能力还分布于项目Key解析、账户requestAuth、用量scope和旧设置migration，不能只删购买页后宣称相关代码已全部清除；必要的历史迁移随数据保留策略维护。

## 4. 可以不发行，物理删除可后置

| 内容                                            | 当前建议与依据                                                                                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/web`                                  | 不发行独立Web/手机端。要物理删，先处理web-share对其认证/素材的引用（`web-share/src/main.tsx:7`、`vite.config.ts:33`），以及统一CLI-Web构建（`scripts/build-zcode.mjs:154`）、root脚本/typecheck/bootstrap/测试alias                      |
| `packages/zcode-server-cli`与SSH/WSL/远端资源   | 停远端制品构建，先保留源码。E2E虚拟项目直接借其HTTP core（`packages/desktop/test/e2e/fixtures/virtual-project/server.ts:15`）；迁移测试支撑后才删。关闭远程入口不能据此删workspaceIdentity/owner/lease                                   |
| 本地Automations/scheduler                       | 首版停止派发和工具入口；今后确定永久不做定时任务才物理裁。保留通用background job、进程生命周期和队列                                                                                                                                     |
| skill-creator / plugin-creator / zcode-guide    | 普通模式不发行或隐藏；guide可替换品牌帮助。三个包受跟踪源码合计约116KiB，物理删收益小，且Office建议提示/设置有入口（`packages/ui/src/v4/officeSuggestedPrompts.ts:311`、`:331`）                                                         |
| 独立TUI与CLI发布命令                            | 可以停止发行TUI/统一CLI包；桌面app-server构建本来不加载TUI（`prepare-agent-node-bundle.mjs:10`）。`apps/zcode-cli/packages/cli`仍产出桌面Agent入口，不能因为用户不接触命令行而整删                                                       |
| `packages/e2e-report` / `packages/formal-proof` | 保留工程用途，不发给用户。前者被桌面E2E导入；后者的model是CLI黄金测试oracle（`bootstrap/tests/formal-proof-consistency.test.ts:18`）。可单独裁独立viewer，不能以删回归支撑作为默认瘦身手段；e2e-report当前生产dependency归类值得单独核验 |

## 5. 当前不应该整删的内容

- `apps/zcode-cli` 的 core/adapters/bootstrap/contracts/CLI app-server，以及 `packages/desktop`、ui、services、client、rpc、shared、provider、provider-node。
- 四个Office插件与 `office-runtime`、Browser Use、Node REPL、Skills/MCP加载机制、Shell、文件/Git工具、权限与会话恢复。
- `packages/server`：Main的open-in-editor和Host连接管理仍静态引用，`packages/desktop/tsup.config.ts:266`、`:359`内联它；应先解运行依赖，不能按“server=云服务”删除。
- `visualize-plugin`：桌面Gen UI资产复制直接读取其中assets并校验hash（`packages/desktop/scripts/gen-ui-runtime-assets.mjs:5`、`:12`）。当前不是一个独立无消费者的skill。
- `packages/zcode-cua` facade 与 `node-repl-host`：CUA生产实现占位不等于接口可随删；Node REPL仍引用其契约，浏览器也依赖共用宿主。可以不发行CUA产品入口，不能连带破坏Browser Use。
- 原生工具归档、生成的Bash命令注册表、`third-party`、LICENSE/NOTICE/第三方声明：名字像依赖/生成文件不代表可随时删除。原生搜索plan从仓库归档取固定校验输入（`scripts/native-search-tools-config.mjs:9`）。以后若裁Linux/远端目标，要同步收窄release plan/校验/许可材料；保留Windows/macOS所需工具。

## 6. 实施顺序与真实验证状态

1. 固定可构建的品牌桌面基线和当前四类成果预览smoke；记录产品包的真实依赖/资源闭包。
2. 第一PR：按第2节选独立端/已退役插件，先小批删除；文档镜像可另开文档PR。维护spec、注册与构建清单。
3. 第二PR：营销奖励、Bots；第三PR：官方发布/分享/图片搜索。每批保留工具多轮与恢复验收。
4. 接通05/06的自有登录与managed access，把原商业服务中的通用策略迁出，再裁套餐/团队/官方凭据/高速闲时链。
5. 根据真实安装包分析决定Web/远端/TUI相关构建闭包裁剪，保留开发验收工具；不按目录名继续大删。

本次执行：`check-workspace-freshness.mjs --no-fetch`通过，仅针对缓存origin/main；`pnpm knip`失败（找不到knip），`pnpm dep:refs ...marketingTouchService.ts:createMarketingTouchService`失败（找不到ts-morph），均因node_modules尚未安装。**没有取得“无引用”的分析结果。** 当前建议由源码import、注册、构建/资源合同交叉核对形成，尚未经删后构建/运行验证。

实际删除前使用architecture-governance取目标上下文并完成spec/相关回归维护，安装依赖后跑knip与不限制包的dep:refs；再补动态注册、字符串路径、插件/资源与远端清单检查。注意dep-refs默认根扫描globs未显式列出 `apps/zcode-cli/packages/*/src`（`scripts/dep-refs.mjs:15`），Agent子工作区需补对应范围/构建图追踪，不能靠一次根扫描证明所有消费者为零。源码删除后必须跑typecheck、lint、架构与受影响工程/CLI/E2E；本轮未删除，不把上述建议标为已验证裁剪成果。
