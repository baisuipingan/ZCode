# MiloCode 3.17.8：当前应用授权引导发布

状态：准备构建与验收；用户于 2026-11-15 授权发布。实现规格见 [39](39-computer-use-agent-desktop.md)“当前应用授权引导与更新提醒”。仅更新客户端，不需要部署 Sub2API。

## 发布范围与来源

- 当前 App 的版本、真实路径和签名身份由 Desktop main 提供；授权按钮打开固定 macOS 设置面板并定位当前 App，不再选中内部 CLI。专用定位按钮只揭示 App，不执行通用 `open appPath`。
- 缺权恢复指引、回焦只读复查、设备本地一次性更新提醒随包发布；首次建立提醒基线，不把新装误判为升级。Windows 保持原有行为，不展示或打开 macOS 授权功能。
- 版本递增至 3.17.8。提交业务源码和版本后，以明确提交构建 Main、Host、Renderer；CLI / Node REPL 行为未变，重新构建并核对随包来源，不能把旧版本号的 metadata 作为新版来源。
- 使用 Node 24.14.0、pnpm 10.33.2，平台 runtime staging 串行。新产物置于 `packages/desktop/dist-milo-3.17.8-20261115/`，证据置于 `output/3.17.8-release-audit/`。

## 验收与发布顺序

```mermaid
flowchart LR
  C[已提交源码及版本] --> B[串行构建 Windows / Mac]
  B --> F[冻结候选摘要]
  F --> W[Windows runner 同 SHA 安装与运行]
  F --> M[Mac 静态检查与隔离启动 / 新授权入口]
  W --> S[沿用现有密钥签署计划]
  M --> S
  S --> R[上传不可变安装包]
  R --> U[最后更新每平台 stable feed]
  U --> D[官网下载页核对新版]
```

- 源码层已通过 26 项浏览器场景、10 项真实 main handler 隔离检查、真实 Electron `file://` 存储 / 多窗口去重、全仓类型 / lint / 架构检查。本次不改原生执行器，最终包仍要验证资源、公钥、图标、版本、来源及 UI 可启动。
- Windows 验收固定为 `milocode-v3.17.8` 的 `MiloCode-3.17.8-win-x64.exe`，workflow / PowerShell / manifest 三处版本同步，manifest 必须是真实最终 SHA256。不得用上一版 EXE、任意外链或跳过安装 / 登录 / 已有独立 CUA 验收来通过；动态任务在新候选上传 Draft 后执行。
- Mac 最终 App 验证签名、DMG 拖拽安装、ZIP 一致性、内置执行器与更新身份。使用隔离用户数据冷启动，验证版本 / 当前 App 元数据 / 登录入口及取消。新引导与定位不自动授予权限，不重置 TCC、不结束用户运行中的旧 App、不读取真实会话或凭据；真实权限 denied 如实记录，不用用户反复授权无关的已测输入链。
- 验收只读取冻结候选，不重写包。沿用 Windows `milocode-win-2026-r2` 与 Mac `milocode-updates`，不轮换密钥或变更官网存储设置。
- 沿用现有发布 CLI 和管理员签发上传链路。先 prepare / dry-run / 固定公钥独立核验，再上传不可变包，最后更新每平台 feed。保留 3.17.7 及之前发行对象。发布后核对公开 HEAD / Range / feed 签名及官网 `/api/v1/desktop/downloads` 两平台版本和链接。
- 磁盘空间有限，只按已确认清单清理可重建临时目录；保留最终包、证据、密钥、真实用户数据和运行中 App。
