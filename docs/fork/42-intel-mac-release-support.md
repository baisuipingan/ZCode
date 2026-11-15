# MiloCode Intel Mac 发布支持

状态：已实现并完成 3.17.8 Intel DMG/ZIP 候选构建及静态验收，2026-11-15；未完成 Intel 实机运行验收，未正式发布，不改变现有版本号。

## 产品与架构边界

macOS 提供独立 Apple Silicon ARM64 与 Intel x64 包，系统下限均保持 macOS 13。程序身份、数据目录、登录与发布公钥保持一致；更新始终留在当前架构，不能把 Intel 包写进 ARM64 feed。

构建的唯一目标由既有 `ZCODE_TARGET_OS` / `ZCODE_TARGET_ARCH` 指定。`electron-builder` 继续输出 DMG 和 ZIP；Sparkle Node-API 桥与资源暂存按 `darwin-arm64` / `darwin-x64` 隔离，安装包内仍放在固定的 `Resources/milocode-update`。Main 只允许这两个 Mac 架构启用原生更新，不改变原有安装准入、退出屏障或签名策略。

发布工具保留旧 `mac` 配置为 ARM64，新增同形的 `macX64` 配置；允许只准备一个架构或同时准备两个架构。每个配置都使用真实 ZIP、可选 DMG、官方 Sparkle 工具及既有专用签名身份。两架构独立生成并签署 appcast，版本资源仍不可覆盖，先资源、后 feed 的顺序不变。发布计划只允许对应架构的固定路径与格式，并要求各 Mac feed 引用本计划中同架构的唯一 ZIP。

| 平台           | ZIP / DMG                                                                         | stable feed                                |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `darwin-arm64` | `milocode/releases/<version>/darwin-arm64/MiloCode-<version>-mac-arm64.{zip,dmg}` | `milocode/stable/darwin-arm64/appcast.xml` |
| `darwin-x64`   | `milocode/releases/<version>/darwin-x64/MiloCode-<version>-mac-x64.{zip,dmg}`     | `milocode/stable/darwin-x64/appcast.xml`   |

```text
明确目标架构 → 构建该架构的 Electron / 原生资源 / Sparkle 桥
               → 真实包验收 → 对应 mac / macX64 输入
               → 各自签名 ZIP 与 appcast → 验证所有资源 → 各自 stable feed
```

## 原生附加资源

`agent-desktop` 固定 v1.3.1，官方发布提供 `x86_64-apple-darwin`。添加前先通过 GitHub release API 的 asset digest 校验完整归档，再记录实际成员摘要；不复用 ARM64 字节，不伪造 hash，不在运行时下载程序。既有 SHA256、精确成员、许可与 provenance 检查同样适用于 Intel。来源：[官方 v1.3.1 发布](https://github.com/vercel-labs/agent-desktop/releases/tag/v1.3.1)。

Intel 包不携带 `ssh2/lib/protocol/crypto/build/**` 的安装机现场编译优化插件。首次实际候选的全量 Mach-O 扫描确认：Electron、PTY、Sparkle 与 CUA 等 27 个原生文件均支持 x86_64，但 Builder 额外收进宿主 ARM64 的 `sshcrypto.node`；现有按包名/路径的门禁没有识别这个可选插件。`ssh2` 1.17.0 的 `crypto.js` 明确捕获插件加载失败并使用 Node/OpenSSL 实现，保留 SSH/SFTP 能力。只对新增的 `darwin-x64` 目标裁剪并 fail-closed 拒绝漏网 build 目录，现有 ARM64、Windows 及 Linux 规则不变；不删除主依赖、源码或通用运行时。工程回归覆盖实际 Builder 配置、目标隔离和漏网拒绝，另做无插件的本地 SSH 握手/加密回环。

## 服务端配套与验收

Sub2API 需扩展 `darwin-x64` 发布对象白名单、公开下载元数据与下载卡片，旧服务端会明确拒绝尚不识别的 x64 上传；客户端工具不能改走另一条无门控路径。

工程回归覆盖：两种 builder 配置使用各自 feed 和架构隔离资源；Mac 发布配置解析；官方 Sparkle 对两个独立 feed 的真实签名；发布计划拒绝跨架构引用和错误对象格式；x64 原生资源准备与校验。执行根 typecheck / lint 和架构检查，报告真实结果。

正式发布仍需校验实际 ZIP / DMG 中的主程序、Sparkle bridge 与原生 sidecar 架构，完成 Intel Mac 或可说明限制的运行验收；当前 Apple Silicon 机器上的配置/签名测试不等于 Intel 实机通过。未完成发布门槛前不切换正式 x64 feed，也不覆盖任何已发布版本。

## 本地实施验证（2026-11-15）

使用仓库固定 Node 24.14.0：发布工具、管理员上传边界、更新签名及 sidecar 的 Node 工程测试 36/36 通过；既有 `electronBuilderSecurity.test.ts` 工程测试 23/23 通过，包含两种 Mac feed / 原生资源路径及真实 Builder schema。Sparkle 测试实际使用固定 2.10.1 官方工具及临时密钥签署独立 ARM64、x64 和双架构发布计划，并拒绝把 x64 feed 改指向 ARM64 ZIP；测试 DMG 仅为不可执行的工程占位字节，不是安装包验收。

根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 为 0 errors / 84 项存量 warnings，未修改无关代码。`git diff --check` 通过。未新增已退役的 App 业务单测。

官方 Intel `agent-desktop` 完整归档 SHA256 与 GitHub asset digest 一致，实际资源准备和许可/provenance 校验通过。`file` 确认主程序、macOS helper、实际编译出的 Sparkle Node-API 桥均为 `x86_64`；桥的免费 ad-hoc 签名通过 `codesign --verify --strict`。归档缓存名、sidecar 输出与 Sparkle 桥暂存均由目标架构区分；共享的 Sparkle 分发缓存是相同固定版本的官方 universal framework，不复用 ARM64 桥字节。

实际候选第一次扫描发现的 ARM64 `sshcrypto.node` 已按上面的 Intel 专属策略修复；拒绝候选的摘要与扫描证据保留，失败包和临时 App 已删除。修复后两个工程测试文件 35/35 通过（包含原 Builder 安全测试和原生包策略），根 typecheck、lint（0 errors / 84 项存量 warnings）、架构检查（0 violations）和格式检查通过。真实 `ssh2` 客户端/服务端在禁用可选插件后，分别以 AES-GCM、AES-CTR、ChaCha20-Poly1305 完成本地握手、认证和中文/emoji 加密通道回环；这是宿主 Node 验证，不冒充 Intel Electron 实跑。

使用 production 配置完整重建 CLI、插件、Main/Host/Renderer 后，生成 `packages/desktop/dist-milo-3.17.8-intel-20261115/` 下的真实候选包。修复后的只读验收 28/28 通过：27 个包内 Mach-O 均支持 x86_64；SSH 运行库保留且宿主优化插件消失；DMG/ZIP 完整性、关键字节一致、App/框架/桥代码封印、图标、独立 x64 更新源及公钥、DMG 的 `/Applications` 拖拽链接、1x/Retina 安装背景均验证通过。CLI 和 Node REPL 重建摘要与既有 3.17.8 一致。旧 ARM64 ZIP/DMG 和 Windows EXE 的正式摘要逐一重核，均未改变。

| Intel 候选文件                |      字节 | SHA256                                                             |
| ----------------------------- | --------: | ------------------------------------------------------------------ |
| `MiloCode-3.17.8-mac-x64.dmg` | 245380311 | `cff2314a38f7092f30b7d1140ed3c51665bacefee7a3b2ca205b58fd3595d36c` |
| `MiloCode-3.17.8-mac-x64.zip` | 237728551 | `3bff9e17acf15332405df577869769cc29bd46f73089b7ac87a80abc54e7ffb2` |

验收与构建日志置于 `output/3.17.8-intel-release-audit/`，包含工作树来源、首个候选拒绝证据、修复后静态结果和 SSH 回环；该候选来自当前工作树，记录基线 HEAD 和未提交补丁摘要，不将它描述为已提交的正式发行源码。为释放磁盘，验证后的约 732 MiB Builder 临时 App 已移除，最终 DMG/ZIP、blockmap、清单及证据保留；需要运行验收时从最终归档提取。

当前 Apple Silicon 主机尝试 `arch -x86_64 agent-desktop --version` 返回 `Bad CPU type in executable`，未能执行 Intel 程序；未擅自安装 Rosetta 或改系统设置。Intel 完整应用启动、登录、Computer Use 和升级仍需后续真实运行验证。包沿用免费 ad-hoc 签名、未 Apple 公证，Gatekeeper 拒绝结果与代码封印通过分别记录。既有可选窗口吸附 helper 也因本机 CLT 缺少 Intel Swift 兼容库未生成，授权提示仍可用但不吸附；这与先前 ARM64 包的存量状态相同。此次没有修改版本号、上传资源或切换任何 stable feed。

## 首次 Intel 正式发布准备

用户已在知悉上述无 Intel 实机运行验收的限制后，明确要求将网站和 Intel Mac 支持部署生产。按这次明确授权准备首次 Intel 发行，保留该运行验证限制，不将它改写为实机通过；不安装 Rosetta、不轮换正式更新身份、不绕过管理员 step-up。先提交并推送本次源码，再从该提交重新构建 3.17.8 的 Intel App 元数据和归档。先前工作树候选只保留验收/哈希证据，不把它当成已提交源码的正式包。

正式准备沿用 Sparkle 2.10.1 和 Keychain account `milocode-updates`，生成仅含 `darwin-x64` 对象的本地发布计划；安装包先上传并核对公网真实长度/摘要，最后才更新独立 x64 feed。须等 Sub2API 的 x64 上传白名单支持正式上线再执行上传，ARM64/Windows 的既有发行对象和 feed 原样保留。构建与发布证据置于 `output/3.17.8-intel-production-audit/`；发布后的实际包摘要、来源提交与结果补记于本规格。
