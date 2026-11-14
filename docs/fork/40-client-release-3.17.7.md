# MiloCode 3.17.7：Computer Use 发布验收

状态：Mac ARM64 与 Windows x64 的 3.17.7 已正式发布，平台验收与公网核验通过。最终业务源码为 `1ba26548035a9675264232c836cf0afeeb079d72`，后续验收记录提交不改变其构建归属。Sub2API 无需变更。

## 发布合同

- 版本递增至 3.17.7，保留 3.17.6 所有已发布资源；沿用 Windows `milocode-win-2026-r2` 和 Mac `milocode-updates` 的更新身份，不轮换密钥、不购买证书。
- 实现与运行边界遵循 [39 号规格](39-computer-use-agent-desktop.md)。先提交业务源码与版本，再由明确 HEAD 真实构建 CLI、Main、Host 和 Renderer；本轮 CLI 变化不能复用旧版 staging。
- 使用 Node 24.14.0、pnpm 10.33.2；依次构建 Windows x64 NSIS、Mac ARM64 DMG / 更新 ZIP。平台 staging 串行，打包期间不执行并行类型检查。新证据放在 `output/3.17.7-release-audit/`，正式候选放在 `packages/desktop/dist-milo-3.17.7-20261114/`。
- Windows 使用最终同 SHA256 的 GitHub Draft Release EXE 在既有 Windows runner 验证安装向导、安装、登录页及卸载。增加 Computer Use 原生回归，只控制 runner 自建的独立窗口，通过最终安装目录内原生执行器验证 snapshot → 真实 ref → 文字输入 → 再观察；缺少交互桌面或操作不成功时明确失败，不把静态检查当动态通过。
- Mac 验证最终应用签名、原生 CLI 与 sidecar、权限状态、隔离冷启动、登录入口及 DMG 拖拽布局。真实 Computer Use 成功操作仅针对本任务建立的独立测试窗口；辅助功能/屏幕录制授权必须由用户在系统安全界面完成，不代点、不重置 TCC、不修改已安装应用的账户或历史。
- 工具回归及静态检查通过后冻结候选。Windows runner 与 Mac 验收均通过，才签署本地计划并发布不可变资源与 stable feed；用公开 HEAD / Range / 全量哈希和固定公钥验证，官网从 feed 自动显示新版。未完成的平台保留原正式 feed，不声明该平台发布完成。
- 当前剩余磁盘约 10 GiB；构建结束可清理本轮临时解包目录，保留冻结包、摘要和验收证据；不删除密钥、用户数据及未核对的历史目录。

## 事件与所有者

```mermaid
flowchart LR
  S[已提交源码 HEAD] --> B[串行平台构建]
  B --> F[冻结安装包与摘要]
  F --> W[Windows runner 隔离验收]
  F --> M[Mac 本机隔离验收]
  W --> P[既有发布 CLI 签署与校验]
  M --> P
  P --> R[R2 不可变资源]
  R --> U[最后更新各平台 stable feed]
  U --> D[官网下载页自动读取最新版]
```

源码 HEAD 是构建来源事实；验收只读取最终候选，不重写包。发布 CLI 是正式对象与 feed 写入的唯一入口，安装包内容不经过 Sub2API 下载代理。

## Windows 原生初始化失败诊断

当最终安装版 Node REPL 已握手、但原生 `session start` 失败时，验收仍必须失败，不替换执行器、不换输入路径、不重放桌面操作。验收 harness 可在失败后执行一次独立的受控诊断：使用同一安装目录内的最终原生 binary 和 `nativeEnvironment` 过滤规则，在独立临时 state 目录执行 `--version` 与 `session start --no-trace --name MiloCode`。这两个命令均不读取桌面、不输入、不截图，允许保存受控的 stdout/stderr、退出码及非敏感的 SystemRoot/临时目录是否存在等事实；不得保存完整环境、令牌或任意用户窗口数据。

诊断结果只帮助区分命令参数、二进制依赖和状态目录权限问题，不作为 Computer Use 通过证据。诊断创建的 state 由 harness 单独持有，在有界子进程退出后删除。原始失败、MCP/SDK 阶段、原生诊断三者分开保留，避免把未确认假设写成根因。

### 已确认的 Windows 状态目录初始化问题

首轮最终包在 Windows runner 中 `--version` 成功，`session start --no-trace --name MiloCode` 返回 `INTERNAL: private file DACL grants an untrusted principal`。固定 upstream commit 的 session/tree.rs 首先确保状态根私有；Windows private_file/path.rs 只在叶目录由原生程序新建时保护 DACL，对已有叶目录仅校验。Runtime 的 Node `mkdir(..., mode: 0700)` 提前创建了该叶目录，Windows 忽略 POSIX mode、保留继承 ACE，因而与上游私有目录合同冲突。这不是启动参数错误或已证实的二进制依赖缺失，也不能把失败归为 runner 本身。

按 39 号规格修复产品与诊断的创建顺序：Windows runtime/harness 只准备父目录并选定随机的、调用前不存在的 `AGENT_DESKTOP_HOME` 叶路径，由同一固定 provider 创建并设置 ACL；macOS runtime 保持原有 `0700` 创建行为。诊断不能提前 mkdir/chmod 状态叶目录，不能放宽 DACL 校验或修改测试结果来通过。原始失败证据保留；修复后必须提交新的业务源码、真实重构建 CLI 与双平台最终包，再重新冻结摘要和运行平台验收，原首轮候选的 hash 不能沿用于新包。

修复候选单独放在 `packages/desktop/dist-milo-3.17.7-20261114-aclfix/`，本轮记录放在 `output/3.17.7-aclfix-audit/`；首轮未发布候选及失败证据保留。Mac 免费临时签名的代码身份随最终构建变化，系统记录的旧版授权不能作为新包已授权的证据，必须按最终包实际权限复测。

## 最终候选验证

- 从上述业务提交重新构建 CLI、Node REPL、Main、Host、Renderer 与两平台 runtime staging。CLI SHA256 为 `a0b89b509a396fc2249634c5a417f6ea7c829091b666626f6306abcf533986d5`，Node REPL SHA256 为 `f2ed21f7250fdf0eca978c18fe3b7618874af3d115a5e69e6dbee576484e011b`；源码产物、平台 staging、包内文件及冻结记录逐一核对。
- 全仓 `pnpm typecheck` 通过；全仓 lint 为 0 errors、84 条既有 warnings。Windows 状态目录回归先在旧实现红测，再于修复后连同其余 CUA 用例 15/15 通过；工程诊断与验收 transport 8/8 通过，架构检查 0 violations。推送 hook 的 affected selector 选中全套 158 项后按仓库规则跳过，不能将其写成 158 项测试执行通过。
- Windows 三项静态检查通过，包含原生资源、公钥、最终 CLI / REPL、图标和 NSIS 工具链。[Windows 实机 CI](https://github.com/baisuipingan/ZCode/actions/runs/43601966735) 使用同 SHA256 的最终 EXE，安装向导、安装、可点击登录页、卸载及快捷方式清理均通过。安装目录内 Node REPL → broker → SDK → 原生执行器发现 41 个工具；限定唯一自建窗口，以真实 ref 前台输入一次中文与 emoji，新 snapshot 与独立窗口回显完全一致，停止后 refs 清空、REPL 正常退出。
- Mac 27/27 静态检查通过，包括 DMG / ZIP / builder App 内容一致、签名、原生 CLI / sidecar、Sparkle、图标及拖拽安装布局。用户为最终临时签名包手动授权辅助功能后，以 LaunchServices 启动最终包中的 Electron Node → Node REPL → SDK → 执行器，限定测试进程 PID、唯一 window ID、AX 窗口标题及字段 native ID；真实 ref 输入中文与 emoji 后，AX 新观察和窗口独立回显完全一致，停止、进程退出及私有 state 清理通过。
- Mac 系统 CG 窗口标题在未授权屏幕录制时可回退为应用名称，验收目标使用真实 PID / window ID、AX 标题与自有窗口状态交叉核对；不宽松接受任意同名应用。当前屏幕录制权限仍 denied，未验证真实截图能力。没有操作用户工作内容、交换真实登录 token 或调用付费模型。
- Mac 最终 App 隔离冷启动、真实 safeStorage 加解密、PKCE S256 / loopback 登录发起与取消、中英文原生菜单 / About、启动 Logo 和 1200 / 920px 布局均通过，`pageErrors=[]`。系统钥匙串提示由用户手动允许；本次没有验证真实账号 token 交换、付费 Agent 会话或完整原位升级。
- 更新清单以既有固定公钥独立验证：Windows Ed25519 清单签名、Mac Sparkle feed 和 ZIP 签名及所有本地计划对象的完整哈希通过。正式发布沿用现有身份，旧版资源保留。

| 最终文件 | 字节 | SHA256 |
| --- | ---: | --- |
| Windows x64 EXE | 199560596 | `d3f395755eae5849b69b0245df9e4b8eb6b938a70364c925ed52503b6dfdef40` |
| Windows blockmap | 209871 | `a39bd49392dc4c49115a1e1fcd175308850c5ded4dcb7528ce0b7a2702388bc0` |
| Mac ARM64 ZIP | 230370495 | `d160c3d5a72c3cd8c88463dc45c827d437e94c1f3b00e6f4262da28eee278a25` |
| Mac ARM64 DMG | 238088766 | `f35a6f78df044272d9014b6090ed0caa789e8bda553db3d3316b3794608d440e` |

## 正式发布结果

两个平台由既有发布 CLI 分别完成不可变资源上传、公开 HEAD / Range / 流式全量 GET 与 SHA512 核验，最后更新各自 stable feed。回执为 `output/3.17.7-aclfix-audit/windows-publish.json` 和 `mac-publish.json`；正式计划为 `output/milocode-release/3.17.7-windows/` 与 `3.17.7-mac/`。未部署 Sub2API，也未修改生产设置或旧版发行资源。

独立公网核验 `public-range-verification.json` 首轮通过：6 个对象的 HEAD、MIME、缓存、Range 均符合计划；4 个候选文件首 / 中 / 尾各 64 KiB 与本地冻结字节一致，两个 stable feed 完整 GET / 哈希 / 固定公钥验签通过。独立读取共 794,573 字节，整包完整公网 SHA512 门禁归属发布 CLI 成功回执，不宣称独立脚本又下载并校验过整包。生产 `GET /api/v1/desktop/downloads` 两平台均为 3.17.7，链接及长度精确对应最终 EXE / DMG，无需缓存重试。

GitHub [milocode-v3.17.7](https://github.com/baisuipingan/ZCode/releases/tag/milocode-v3.17.7) 已公开；四个 assets 的 GitHub SHA256、长度与冻结记录一致。Windows 3.17.4 及以后版本沿用原更新身份；Mac 提供 DMG 拖拽安装及 Sparkle ZIP 更新。官网下载页 `/downloads` 自动读取新 feed，无需变更网站版本。

本轮旧候选的可再生解包目录已清理；冻结 EXE / ZIP / DMG、全部证据及更新密钥保留。最终验收进程均退出，原生私有 state 已清理；源码保留在 `codex/milocode-computer-use`，本次未合并主分支。
