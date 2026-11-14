# MiloCode 3.17.8：当前应用授权引导发布

状态：MiloCode 3.17.8 Windows x64 与 Mac ARM64 已于 2026-11-15 正式发布。实现规格见 [39](39-computer-use-agent-desktop.md)“当前应用授权引导与更新提醒”。仅更新客户端，没有部署 Sub2API。

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

## 最终验收与发布结果

- 正式业务源码固定为 `2ff9f0e6d4782c63e84bde8f208e36b3af910ce1`。验收合同提交为 `77c72d46ff46205147514c54cf3f7e8900f9579e`，Windows workflow [run 43615153543](https://github.com/baisuipingan/ZCode/actions/runs/43615153543) 通过，验收的是与下面摘要一致的最终安装包。
- 全仓 `pnpm typecheck` 通过；lint 为 0 errors、84 条既有 warnings；`architecture:check --changed` 为 0 violations；`git diff --check` 通过。受影响工程测试选择器选中 158 项后按仓库规则跳过，不记作 158 项测试通过。
- Windows 静态包验收通过；runner 实际安装、登录页、41 个 Computer Use 工具发现、独立测试窗口中文与 emoji 输入/回显、停止清理及卸载通过。截图经人工视觉检查，runner 清理无错误。
- Mac 静态验收 27/27、最终候选隔离冷启动及 IPC 通过：当前 App 版本/realpath/签名身份匹配；定位和两个权限入口只指向当前 App；登录 PKCE 发起/取消和真实 `safeStorage` 合成数据加解密通过，`pageErrors=[]`。没有读取用户 token、调用付费模型、修改 TCC 或声明已授予系统权限。
- CUA 源 UI 浏览器专项 22/22 通过。相同浏览器批次另外 37 项通过、1 项无关既有用例失败：provider model editor 对像素宽度使用严格相等，实际为约 `15.9869`、期望 `16`（`provider-model-editor-progressive-cases.mjs:145`）；该失败与本次权限引导无关，未改断言或将其写作通过。
- Mac 仍是免费 ad-hoc 签名、未公证。代码封印验证通过，Gatekeeper 拒绝结果已单独记录；新包首次运行的系统授权仍由用户手动完成。本次没有用授权引导冒充系统已批准。
- 独立离线计划核验确认冻结文件摘要与签名计划一致，Windows 更新清单及 Mac Sparkle feed/ZIP 签名通过固定原公钥验证。GitHub 四个 Draft assets 的 size/SHA256 与冻结包完全匹配。
- 两平台不可变对象先上传并通过发布器完整公网 GET/SHA512，再分别更新 stable feed。独立公网核验确认六对象 HEAD/MIME/cache/Range 正确，四个安装包首/中/尾采样字节均匹配本地冻结包；两个更新 feed 签名有效。生产 `GET /api/v1/desktop/downloads` 返回 Windows `3.17.8` EXE（199559833 bytes）及 Mac `3.17.8` DMG（238115772 bytes），均指向预期 R2 地址。
- GitHub [milocode-v3.17.8](https://github.com/baisuipingan/ZCode/releases/tag/milocode-v3.17.8) 已公开，四个 assets 摘要如下：

| 最终文件 | 字节 | SHA256 |
| --- | ---: | --- |
| Windows x64 EXE | 199559833 | `9e067ba0e6d936e08122470cc75ffd5897235004fe312e1ef181f119db917880` |
| Windows blockmap | 210625 | `ec8f75024fb13c50f36a626e18f81986a32d47b51e69ebefedeb6c96e956961f` |
| Mac ARM64 ZIP | 230373080 | `dd97abc04cfcd2830d9c78a2abe4e27ac8da22b74556ce101cfd382135a90b9f` |
| Mac ARM64 DMG | 238115772 | `aa721a0820223b697bf27a9e9350c36146c4aa1e7207a926dd514587ee041792` |

- 官网 `/downloads` 通过既有 API/feed 自动显示 3.17.8；无需再次部署 Sub2API。Windows 和 Mac 均沿用原更新密钥，未轮换；3.17.7 及更早版本对象保留。
