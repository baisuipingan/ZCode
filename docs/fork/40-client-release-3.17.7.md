# MiloCode 3.17.7：Computer Use 发布验收

状态：准备候选包。用户在 Vercel 执行器接入完成后授权继续；本次推进真实构建、平台验收与发布，Sub2API 无需变更。

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
