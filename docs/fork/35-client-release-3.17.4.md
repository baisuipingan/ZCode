# MiloCode 3.17.4 发布规格与记录

状态：2026-11-14 发布准备，尚未构建、上传或切换正式 stable。本次由用户授权发布最新 Windows x64 与 macOS ARM64 客户端；不得覆盖已发布的 3.17.3 资源。

## 发布范围与唯一事实源

- 版本以根 `package.json` 的 `3.17.4` 为唯一来源；桌面 metadata、安装器和更新归档复用现有版本解析，不增加独立版本表。
- 最新业务源码先提交，再重编 Main、Host、Renderer 和 Agent CLI；metadata 必须记录该源码提交。旧 `out/`、3.17.3 正式包和 `local-repair` 候选均不能充当本版构建输入的替代证据。
- 包含公开模型目录协议 4：保留官方完整上下文和输出上限语义，以及对旧服务端协议 3 的一次精确协商回退。登录、授权 epoch、换号隔离、手动更新和安全存储合同不变。
- Windows 采用 [34 号规格](34-windows-installer-toolchain-repair.md)的完整、校验摘要固定的 NSIS 1.2.1 工具链和白底 Milo 应用图标。客户端内部 Logo 保持原样。
- macOS 使用既有 ad-hoc 签名，生成拖至 Applications 的 DMG 和供 Sparkle 更新的 ZIP；不声明 Apple Developer ID 签名或公证。

发布工具是本地计划与上传顺序的唯一 owner，客户端只消费公开签名 feed：

```text
已提交源码 → 同次真实编译 → 平台 runtime staging → 独立目录安装包
  → 冻结摘要 → 最终字节验收 → 签署版本计划
  → 不可变版本资源 → 公网长度/Range/完整摘要核对 → 对应平台 stable feed
```

每个平台单独完成 staging 与打包后才切换另一平台，避免本机开发 CLI 暂存覆盖 Windows 资源。所有资源仍由现有 runtime producer、依赖闭包及原生资源门禁验证，禁止关闭门禁或改用宽松缺依赖选项。

## 构建输入与路径

固定 Node `24.14.0`、pnpm `10.33.2`，通过进程 `PATH` 中的独立 shim 保证打包器及 Agent 子进程均使用同一 pnpm；不重装项目依赖。构建环境为 `ZCODE_ENV=production`，更新根固定为 `https://download.editor.vip/milocode/`。Mac 公钥和 Sparkle 身份保持原样；Windows 按下文已授权的恢复流程更换发布身份。

产物使用新的 `packages/desktop/dist-milo-3.17.4-20261114/`；日志、摘要、验收材料放在 `output/3.17.4-release-audit/`。正式版本资源位置遵循 [31 号发布合同](31-client-update-release-guide.md)。

构建顺序：

1. root 提交源码和版本后，记录完整 source HEAD；运行根 typecheck、lint 和架构门禁。
2. 使用生产环境执行桌面完整 build，真实重新编译最新 Agent、Main、Host 和 Renderer，并记录 metadata 与 CLI 摘要。
3. 以 `ZCODE_TARGET_OS=win32`、`ZCODE_TARGET_ARCH=x64` 重新执行 `prepare:runtime-assets`，然后以 `--skip-prepare --skip-build --os win --arch x64` 打包，门禁保持开启。
4. 以 `ZCODE_TARGET_OS=darwin`、`ZCODE_TARGET_ARCH=arm64` 重新执行 `prepare:runtime-assets`，然后以 `--skip-prepare --skip-build --os mac --arch arm64` 打包，采用既有免费 ad-hoc 签名。
5. 比对同一源码 CLI、各平台 staging 与最终包 CLI 的 SHA256，并核对 Main metadata 的版本和 source HEAD。

## 验收与发布条件

- 根 typecheck、lint、架构检查、范围格式及差异检查按真实结果记录；现有 Host / HTTP / 授权回归必须通过。
- Windows 验证实际最终 EXE 的 NSIS compiler/runtime 变量区一致、全部安装器/内嵌应用图标匹配、归档完整、x64 原生依赖与最新 CLI 摘要一致；同 SHA256 的最终 EXE 必须通过 GitHub Windows runner 向导、安装、真实应用页面、卸载验收。静态检查不能代替该运行证据。
- macOS 检查最终 DMG 挂载、应用身份、ARM64 架构、完整 ad-hoc 签名、Sparkle framework 和桥接模块，并从实际包的隔离副本验证冷启动、登录发起及取消；不发起付费模型调用，不修改用户安装或数据。
- Mac 发布密钥沿用既有身份，不能静默创建或轮换。Mac Keychain account 为 `milocode-updates`，是否能签署以正式 prepare 的真实结果为准。
- Windows 原正式私钥经本机、隐藏目录及已有备份搜索无法恢复；用户已明确授权“更换密钥，发布新版 Windows 包”。按下文恢复流程生成新身份，不修改旧 3.17.3 资源，不声称旧客户端可以连续信任新签名。
- 发布计划、构建日志和 Git 中禁止包含管理员会话、API Key、S3 凭据、私钥或可用预签名 URL。

## 准备阶段证据

- 客户端只读审查未发现新增发布阻断问题，4 份现有 Host / HTTP / 授权运行时回归 65/65 通过，架构 0 violations；证据见同目录 `output/3.17.4-release-audit/client-audit.md`。
- 2026-11-14 检查登录 Keychain：`milocode-updates` 项存在；检查没有读取或输出私钥。
- 构建私有默认配置包含现有更新根、Windows 公钥及 Sparkle 公钥；当前进程无 NSIS 外部覆盖。
- 当前可用磁盘约 9 GiB，需顺序构建并及时清理本轮可再生 unpacked 验收副本；保留正式包、摘要和验收证据，不删除用户应用、卷或历史正式资源。

后续回填真实 source HEAD、产物摘要、运行证据和是否正式发布，不将准备完成写成发布成功。

## Windows 发布身份恢复

本次新 key ID 为 `milocode-win-2026-r2`。唯一生成入口仍为现有 `scripts/milocode-release.mjs keys`，显式使用 `~/.config/milocode-release/keys/`；目录必须为 `0700`，私钥必须为 `0600`，且禁止覆盖既有文件。新私钥不存入 AppSupport、源码、日志、聊天、命令行参数、安装包或发布桶。

新私钥另存 macOS 登录 Keychain 的独立 generic-password 项，service 为 `app.milo.code.release-signing`、account 为 `milocode-win-2026-r2`。备份通过 Security framework 的 `SecItemAdd` 接收内存中的 PEM；使用 `SecItemCopyMatching` 读回后只在内存逐字节比较，不打印私钥，不使用 `security -w <明文>` 参数，不修改现有 Keychain 的全局访问权限。该副本是本机 Keychain 的受保护恢复副本，不等同于已经完成跨设备或离线灾难恢复备份。

备份成功后，仅更新被 Git 忽略的 `config/private/build-defaults.json` 中 `MILOCODE_UPDATE_PUBLIC_KEYS_JSON`，信任表只包含新 Windows 公钥。旧公钥保留在原 3.17.3 正式包及本轮审计证据中，供识别旧身份；不把已经丢失私钥的旧身份继续视为可发布身份。Sparkle 公钥、更新根及其他构建配置必须逐项保持不变。

此流程的事件顺序与唯一所有者为：

```text
用户明确授权 → 现有 release CLI 生成新 Windows 身份
  → Security framework 写入并内存读回核对受保护备份
  → 原子更新本机 Windows 公钥构建配置
  → 提交公开规格 → 新提交真实重编/metadata
  → 独立新目录安装包 → 同一摘要 Windows runner 验收 → 正式签署及发布
```

已构建但尚未公开的旧公钥 3.17.4 Windows 候选复制到 `output/3.17.4-release-audit/pre-rotation-windows/` 留证。新候选输出到 `packages/desktop/dist-milo-3.17.4-20261114-rekey/win-x64/`，不覆盖原候选、3.17.3 正式资源或已验收的 Mac 3.17.4。

旧 Windows 3.17.3 客户端只信任旧公钥，无法安全地自动接受新身份发布的清单；用户需要从官方下载页手动安装一次新 3.17.4 引导版，此后由新公钥继续验证后续更新。不能关闭验签、添加不签名 fallback 或把单纯保留旧公钥称为完成信任迁移。

2026-11-14 身份准备已完成：新目录及私钥权限分别为 `0700` / `0600`；Keychain 受保护副本写入后实际读回，仅在内存比较，结果一致。构建配置仅修改 Windows 公钥，Sparkle 公钥和所有其他默认配置逐项保持不变；新包信任表仅包含 `milocode-win-2026-r2`。新公钥 SPKI DER SHA256 为 `998ee4347085aa9e4ad109c2c99d6b76386be0f816b60c71d8244f8a053792f9`；旧公钥指纹为 `bb6d6f9d22a9db2d1c14f2ea1c8e740716000e80af49c9583d63956b04653164`，仅保留作旧身份审计说明。

新 Windows 候选的静态验收必须精确断言新 key ID、单 key 信任集合及上述新指纹，不得通过删除原来的公钥断言来放宽校验。旧候选的 runner 结果也不能证明新候选字节可运行；新 EXE 必须重新冻结 SHA256、替换未公开 Draft 资产并执行同摘要运行验收，均由集成任务统一操作。密钥准备证据位于被 Git 忽略的 `output/3.17.4-release-audit/key-rotation/`，不得把私钥或其内容提交进仓库。
