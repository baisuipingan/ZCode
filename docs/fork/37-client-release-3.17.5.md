# MiloCode 3.17.5 发布规格与记录

2026-11-14。用户已授权发布本轮 [全面品牌复审](36-user-visible-branding-audit.md) 修复，目标为 Windows x64 与 macOS ARM64 正式 stable。

## 发布规则

- 根 `package.json` 为版本唯一来源，版本递增为 `3.17.5`，根 lock 元数据同步；不得覆盖 3.17.4 的安装包、签名或资源。
- 品牌修复、版本及规格先提交，再从该 source HEAD 真实编译 Agent、Main、Host、Renderer。每个平台的 runtime staging 与打包顺序执行，不并行覆盖平台资源。
- Windows 沿用 `milocode-win-2026-r2`，SPKI DER SHA256 为 `998ee4347085aa9e4ad109c2c99d6b76386be0f816b60c71d8244f8a053792f9`；macOS 沿用 Sparkle `milocode-updates`。不生成或轮换密钥。
- Windows 继续采用完整固定 NSIS 工具链与现有安装器；Mac 继续提供拖入 Applications 的 DMG 和 Sparkle ZIP，使用现有免费 ad-hoc 签名，不声明 Apple 签名或公证。
- 固定 Node 24.14.0、pnpm 10.33.2，生产构建配置，更新根 `https://download.editor.vip/milocode/`。产物目录 `packages/desktop/dist-milo-3.17.5-20261114/`，证据目录 `output/3.17.5-release-audit/`。
- 最终 Windows EXE 冻结摘要后，更新既有 Windows 验收清单并用同一份字节运行 CI。后续仅验收脚本或发布记录提交不冒充 App 编译来源。

## 验证与切换

沿用 [31 号发布操作合同](31-client-update-release-guide.md) 与 [35 号上一版记录](35-client-release-3.17.4.md)：先验证源码门禁，后验证最终安装包。Windows 需要真实向导、安装、可点击登录页与卸载；Mac 需要 DMG/ZIP、应用身份、当前菜单、冷启动与登录发起检查。保留原生菜单中英文验收，不发送付费模型请求。

由既有发布工具签署计划并验证，再按不可变资源、完整公网摘要检查、平台 stable feed 的顺序发布。通过生产下载 API 确认两平台 `3.17.5`；无需因客户端发包重部署 Sub2API。每个平台独立记录验收与发布时间，不把本地生成清单视为上线成功。

## 执行结果

待构建与验收后填写。当前尚未更新 stable。
