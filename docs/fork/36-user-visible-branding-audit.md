# MiloCode 全面可见品牌复审

2026-11-14，用户在已发布的 3.17.4 macOS 应用菜单发现「关于 ZCode」。延续 [29 号品牌规则](29-visible-milocode-branding.md)，本轮全面复审生产源码及构建输入中的用户可见旧品牌，并修复遗漏。不是全局标识重命名。

## 规则与所有者

- 自家产品在原生菜单、关于窗口、托盘、通知、系统服务、多语言 UI、下载和授权页面、安装器展示字段中统一显示 MiloCode。
- 直接修复文案唯一来源；共享菜单文案由 `packages/shared` 持有，Main 继续消费既有接口，不在菜单组装处增加替换器或独立品牌设置。
- 内部包名、类型、IPC、协议、URL scheme、环境变量、存储 key、`.zcode` 目录、注册与系统服务归属标识保持兼容。历史文档、上游署名、第三方插件的实际名称和真实技术路径不能虚假改名。
- 技术错误若参与匹配或分类，保留稳定的内部标记；只在已有展示边界修改产品展示名，不修改错误码语义或添加宽泛字符串替换。
- 应用内部 Logo 保持用户既有选择，系统应用图标保持现有白底 Milo 图标。本轮只处理品牌文字遗漏，不改登录、模型、余额、调度、数据迁移或更新信任。
- Finder 服务使用现有工作流路径和归属判断；如修改可见服务标签，必须保证升级能更新现有安装，避免重复服务。
- Linux 桌面入口新写入说明为 MiloCode；读取归属时精确接受新旧两个 Comment 标记，兼容旧 AppImage 升级、系统安装清理及自定义入口保护，不修改文件名、协议或图标 key。

## 审计范围与执行

审计整个受版本管理项目的生产代码和资源，包括 `packages/desktop`、`packages/ui`、`packages/shared`、`packages/services`、`packages/web`、`packages/server`、`apps/zcode-cli`、配置、打包脚本、原生资源和模板，并复核 Sub2API 集成。用字符串/JSX与资源定位展示边界，逐项分类可见文字、兼容标识、诊断内部名称、第三方来源和历史文档。禁止机械替换所有 ZCode 命中。

先写规则并完成源码审计，再修展示来源和必要的构建元数据。实际执行 typecheck、lint、架构检查、受影响的现有工程或浏览器验证。原生菜单需核对中英文「关于 MiloCode」与实际关于窗口；可见中文、英文旧品牌不应仅凭文本搜索被技术引用掩盖。

只在本轮实际生成新包时递增版本，绝不覆盖 3.17.4 的已发布包或签名清单；未生成新包不能宣称用户已安装的应用菜单已经改变。完整审计明细与验证证据放在 `output/branding-audit-20261114/`，完成后回填结果。

命令行分发安装成功提示、Web 启动提示使用 MiloCode，命令名 `zcode` 与安装目录继续兼容。macOS 发布诊断脚本的主应用默认路径与示例跟随实际 `MiloCode.app`，独立 Computer Use Helper 的真实文件名和环境变量保持不变。

门禁范围：三个已准入上游存量文件（诊断日志归档、工作区忽略模板、TUI runtime）因品牌文案改动退出原样上游准入。本轮按既有精确路径例外机制记录纯文案审查，不新增业务代码或更改模块职责；插件诊断入口与 debug 页的既有超长文件只保留行数告警，其余规则照常检查。

## 复审结果

截图根因已确认：原生菜单读取 `packages/shared/src/desktopMenu.ts`，此前修改 React 多语言资源未覆盖这个共享来源。本轮直接修复共享文案，未在 Main 添加字符串替换兜底。

| 范围 | 修复与结论 |
| --- | --- |
| Desktop | 中英文关于菜单、托盘、Endpoint 标签、安装器详情及目录说明、打包展示元数据；Linux 入口新说明与旧归属兼容。 |
| UI / Web / 分享 / 远控 | 页面标题、品牌文案、连接与错误说明、自家下载入口；同步已有 E2E 预期。 |
| CLI / 内置资源 | TUI 启动与侧栏、内置 Guide、技能与插件说明、模型可见提示、可见凭据与初始化错误；真实第三方来源保留。 |
| Shared / Services | 机器人命令与引导、反馈展示名、日志归档说明、文件忽略模板说明、Computer Use 状态展示。 |
| 原生与静态资源 | 补查 Kotlin、Shell、XML、HTML、NSIS、manifest 等。Android 远控壳显示文字同步，但它未接入 MiloRouter、也不属于当前 Win/Mac 交付范围。 |
| Sub2API | 用户可见页面未发现本轮旧品牌遗漏，工作区未修改，无需为此部署；`client_id=zcode-desktop` 为兼容鉴权标识。 |

AST 扫描覆盖 5,618 个受版本管理的 JS/TS 源文件，另检视原生与静态资源。字符串命中包括导入、路径、协议、持久化 key、第三方名称与诊断，不将命中数视为用户可见缺陷数。保留清单见范围报告和 `production-literals.json`、`cli-string-audit-after.json`。

## 实际验证与发布状态

- 最终根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`git diff --check` 通过；Lint 保留 84 条既有告警，0 errors。架构检查 0 violations、0 baseline、0 new。
- 架构与门禁工程回归 51/51 通过；命令行分发进程/安装器回归 6/6 通过。
- CLI 完整类型检查 34/34 tasks 通过，Lint 0 errors；受影响的 22 个既有 Vitest 文件均有最终通过证据，TUI 启动与侧栏 22/22 通过。旧 fixture 预期已更新，磁盘不足引起的一次失败释放旧重复构建输出后单独重跑通过。
- 当前源码生产配置的 Desktop main/host/preload/renderer 编译通过。原生菜单独立 E2E 2/2 通过：真实读取 Electron Menu，分别点击英文和中文关于菜单，检查窗口中的 MiloCode 与应用版本。WDIO 隔离身份 `ZCode E2E` 仅从 Hide/Quit 动态应用名检查中排除，静态菜单仍完整检查旧品牌。
- 原有完整问号菜单 E2E 的旧工作区入口等待失败，4 个场景未进入执行；未把它们记为通过。独立原生场景不依赖该旧登录夹具。
- macOS 发布诊断工程回归 8/8、产品身份回归 14/14 通过。诊断测试修正了将 Helper 展示名当真实可执行文件名的问题；实际 Helper 文件名保持兼容。
- Linux 入口用临时目录验证旧/新归属清理、自定义条目保护、AppImage 更新与协议保留，6 个场景通过；Linux 安装器 metadata 方法实调通过。未正式打 Linux 包；Windows 专用 NSIS smoke 在 Mac 上跳过。
- UI/Web 范围执行了 AST 兼容比较、Lint 和 E2E 脚本语法检查，未执行其真实浏览器场景；Android 资源完成 XML/JSON 解析与精确差异检查，未构建 Android 包。

上述审计结束时尚未提交、推送、发新包或部署。用户随后授权发布，3.17.5 的独立构建、最终安装包验收和上线状态记于 [37 号发布记录](37-client-release-3.17.5.md)。已发布 3.17.4 安装包保持不变；用户需要更新版本后才会看到修复。内部 Logo 和现有系统图标未改。

完整证据目录：`output/branding-audit-20261114/`。主要日志为 `typecheck-final.log`、`lint-final.log`、`architecture-final.log`、`architecture-tooling-tests.log`、`native-menu-e2e.log`、`desktop-doctor-fixed.log`；范围说明为 `cli-review.md`、`ui-web-server-review.md`、`android-ui-resources-review.md`。
