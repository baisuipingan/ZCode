# MiloCode 3.17.6 发布与安装入口修正

2026-11-14。用户授权发布 Mac / Windows 图标比例修复，并修正官网 Mac 手动安装入口。

## 发布合同

- 版本递增为 3.17.6，禁止覆盖已发布 3.17.5 文件或签名。沿用 Windows `milocode-win-2026-r2` 与 Mac `milocode-updates` 正式身份。
- 系统图标按 [28 号规格](28-installed-login-and-startup-fixes.md)分平台留边：Mac 专用 PNG 与 ICNS，Windows PNG / ICO / 安装器及托盘全部尺寸保持 alpha。内部 Logo 不变。
- 业务源码及版本先提交，再从该 HEAD 真实编译 Main / Host / Renderer。CLI 源码未改变，只有在 source dist 与两平台 staging 摘要均与 3.17.5 已验收来源一致时才复用，不将其称为本轮重新编译。
- 使用 Node 24.14.0、pnpm 10.33.2；依次打包 Windows x64、Mac ARM64，不能并行改写平台 staging 或在打包期间执行类型检查。正式文件目录为 `packages/desktop/dist-milo-3.17.6-20261114/`，证据目录 `output/3.17.6-release-audit/`。
- Mac 同时提供 DMG 与 ZIP：DMG 包含 MiloCode.app 和 Applications 拖拽入口，供官网首次/手动安装；ZIP 保留为 Sparkle 应用内更新目标。Sub2API 在解析有效更新版本后，对同源固定版本 DMG 进行受限 HEAD 确认，存在才返回 DMG 下载信息；不改动 appcast 的 ZIP enclosure，不代理安装包流量。
- 正式切换前验证最终包身份、所有图标帧、CLI / 原生资源、安全存储、固定更新公钥、ASAR 完整性。Windows 用最终同 SHA256 EXE 在真实 runner 验证向导、安装、可点击登录页和卸载。Mac 验证 DMG 拖拽布局、与 ZIP / builder 的关键内容一致及原生冷启动登录发起/取消。
- 最终包冻结后才更新 Windows CI 清单、签署发布计划并上传不可变文件；公开 HEAD / Range / 完整摘要验证后才切换 stable feed。网站变更通过 Sub2API 既有不可变镜像发布流程上线；不修改生产模型或存储设置。

## 执行记录

业务源码为 `4e9c43808b0ed1197ac07e076b0354d2ff0c156e`，Main / Host / Renderer 均从该提交真实构建。CLI 源码与 3.17.5 已验收来源没有差异，source dist、Windows staging、Mac staging 的同一文件 SHA256 均为 `baa289259dce7fb9c66c2f085c2827f43d3abe2f54f9761f1f0a5761f8ea8b61`，本轮复用 CLI，没有重新编译它。版本资源、源信息、构建与验收证据位于 `output/3.17.6-release-audit/`。

### Windows x64

- 最终 EXE：198,091,170 bytes，SHA256 `c52e01ea8e47eb4241cbb8282b7b15292e24a8017325c4c5f95cb18330e1a26c`。
- blockmap：208,302 bytes，SHA256 `18995a4aee7d4cbc35b74d70c9b52fdf5ff218339f03ebcbe35085b6844029c4`。
- [最终包 CI 43580952430](https://github.com/baisuipingan/ZCode/actions/runs/43580952430) 成功。CI 提交 `cfe6d693efa06cd9c46f926b51e35a4376914bcc` 只更新验收清单；它不是 App 的业务源码来源。
- 真实 Windows runner 验证向导、安装、可点击登录页和卸载，安装 / 卸载均 exit 0；截图已核对，应用与快捷方式清理通过。安装器、内嵌应用九档图标、运行时 PNG / 托盘 ICO、ASAR、46 项插件和原生资源均通过静态核对。
- 沿用 `milocode-win-2026-r2` 公钥。正式发布工具已完成不可变对象和 stable feed 发布，独立公网完整 GET、固定公钥验签、SHA256 / SHA512、HEAD / Range / 类型 / 缓存检查通过，证据 `windows-public-verification.json`。首次公网整包读取未通过发布门禁，未推进 feed；随后独立完整字节检查匹配，再以相同计划安全重试成功，没有覆盖版本对象或放宽门禁。

### macOS ARM64

冻结 ZIP 为 227,998,293 bytes，SHA256 `848b23cc5374387ec66acdfe04f8d248a6728be6da7cb0ee884568c5ced8b605`。App / ZIP 静态检查与隔离运行验收通过：原生 EN / ZH 菜单和 About、常规及窄窗口、内部启动 Logo、Mac 图标解码、真实浏览器登录发起和取消、干净退出。第二轮冷登录为 4,860 ms；首轮系统日志确认钥匙串提示未获批准而等待超时，第二轮在系统记录用户批准后正常通过，未修改安全策略或用户数据。

最初 DMG（SHA256 `2c17fe33687df1ea63a8672143316ece4fc8d15c1328fcb4b6ec61f4f594f585`）在真实 Finder 验收时发现旧 ZCODE 安装背景，已在正式发布前作废，移除 GitHub 草稿中的该资产，并隔离旧发布计划。App / ZIP 和 Windows 文件保持冻结，仅修正安装背景并重新生成 DMG。最终背景资源源码为 `b2d4110c`，最终 DMG 为 235,607,781 bytes，SHA256 `dfb9d802cf68b79c272e9db1291faf20db3ebe4ca06b909d228603f880cfdc15`。DMG 内应用全部 3,268 项与冻结应用一致，严格代码签名和 `hdiutil verify` 通过；最终静态 27/27 通过，包括 1x / 2x TIFF representation 与背景像素匹配。Finder 实际打开未挂载的最终 DMG 后自动弹出独立安装窗口，MiloCode.app 与 Applications 拖拽入口、品牌及 Retina 清晰度正常。

最终 Mac 计划重新生成并通过 dry-run、固定公钥本地验签后，已由既有发布工具上传不可变 ZIP / DMG 并切换 appcast。独立公网完整 GET、固定公钥 feed / 归档验签、SHA256 / SHA512、HEAD / Range / MIME / 缓存检查通过，证据 `mac-public-verification.json`。沿用 `milocode-updates` 身份，appcast 仍以 ZIP 为更新目标，DMG 只用于官网手动安装；未改变免费 ad-hoc 签名方式，未声称 Apple Developer ID 或公证。

### 官网与最终检查

Sub2API 下载入口修正以 `fork-v0.2.21-19` / `0.2.21-ds.19` 正式部署，源码 `852bcc50498fecfb41177d63bb63d5de405e644f`，镜像摘要 `sha256:6dcfb4085727da5bcdf58ec6733f63a457a230e4cf6cb17e7fdde0aa22d3c1f1`。完整 CI、数据库备份、既有正式部署入口及健康检查通过，schema epoch 保持 4，没有新增迁移。服务端生产 API 与已登录浏览器的真实下载页均确认两平台 `3.17.6`：Windows 为 EXE / 198,091,170 bytes，Mac 为 DMG / 235,607,781 bytes，下载 URL 与本地冻结计划匹配，网页显示正确 DMG 拖入「应用程序」说明。官网不再把 Sparkle ZIP 当作手动安装包。

根目录 typecheck 通过；完整 lint 为 84 项既有 warning、0 error。系统图标与安装背景资源 9/9、生成器 `--check`、局部格式、架构与差异检查通过。GitHub 四份资产的 uploaded 状态、大小与 SHA256 均逐一核对，旧背景 DMG 未进入正式发布。

未执行真实用户 token 交换、付费模型调用或完整原位应用内升级；上述静态、隔离运行与安装验收不替代这些场景。既有 3.17.5 下载、签名和安装包保留。
