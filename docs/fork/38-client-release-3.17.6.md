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

待真实结果补齐。既有 3.17.5 下载、签名和安装包保留。
