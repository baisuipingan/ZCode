# Windows x64 与 macOS ARM64 安装包

2026-11-13，用户要求将当前 ZCode 工作区打成 Windows 64 位与本机 Mac 安装包。本轮沿用已有构建流程，修复实际安装包验收发现的身份遗漏，不提交或发布远端版本。

目标身份为 MiloCode（`app.milo.code`），版本沿用当前 `3.17.2`，使用 `ZCODE_ENV=production`，账户服务连接 `https://milorouter.com`。本机为 macOS ARM64；Windows 目标为 x64。当前没有可用发布证书，本轮生成无发布签名/公证的本地安装包。

Sub2API 实时公开版本为 `0.2.21-ds.14`、健康状态 `ok`，与已有部署记录中的当前后端 commit `28c401e397e351d277600586ee2af62e4617bc18` 一致；本轮不改后端部署。

## 构建与验收规则

- 使用仓库锁定 Node `24.14.0` 与 pnpm `10.33.2`，打包整个已有工作区，包括26号实施记录所述改动，保留其他既有未提交变更。
- 两平台准备当前本地 CLI 与目标原生资源，使用同一份最终生产身份的 Main/Host/Renderer 构建分别打包；共享构建会重新暂存本机开发 CLI，因此在它完成后再次执行 macOS `prepare:runtime-assets`，恢复完整官方插件和原生依赖，再以 `--skip-prepare --skip-build` 打包。不复用旧 Windows CLI 或旧 `_TEST` 安装包。
- 输出分开存放在 `packages/desktop/dist-milo-20261113/mac-arm64` 和 `win-x64`，日志放在相邻 `logs/`。
- 沿用依赖闭包、平台原生文件、包体大小等现有校验；检查安装包实际内嵌 CLI 与当前构建 SHA 一致。
- macOS 包检查挂载、应用身份与架构，并用隔离数据目录验证已打包应用启动、本地浏览及内置终端。生产包固定账户origin，模型/文件完整合成链路沿用26号本地原生验收；Windows 进行安装器和内嵌资源校验，本机不能代替 Windows 安装运行验收。
- 完成后回填产物、摘要、运行结果和限制；不将未签名包称作已完成正式发行验收。

Windows 交叉打包的默认缓存 NSIS 编译器为 Intel 程序，本机没有 Rosetta，实际报 `spawn Unknown system error -86`。本轮曾在产物日志目录创建隔离 NSIS 工具入口，以 Homebrew ARM64 NSIS 3.12 编译器配合 builder 缓存的旧 includes/stubs，通过构建。**2026-11-14 复查确认此做法违反 NSIS 编译器与 stub 必须一致的要求，不能继续使用，构建成功也不能证明安装器正常。** 缺陷证据与替代规则见 [34号修复记录](34-windows-installer-toolchain-repair.md)。本次历史产物和日志保留供排查。

## 结果

macOS 最终构建退出0。`hdiutil verify`、只读挂载、应用 Info.plist 身份、ARM64 可执行文件、内嵌 CLI 与当前源码产物 SHA 一致性、CUA koffi 原生依赖均通过。验收从该 DMG 复制出的可写应用，而非开发服务或另一份旧 `.app`。

实际安装包启动验收 **1/1通过**：`app.isPackaged=true`、运行名称 `MiloCode`、版本 `3.17.2`、架构 `arm64`，Renderer 从该包的 `file://…/app.asar/out/renderer/index.html` 加载；隔离数据目录进入本地浏览、添加/信任本地项目、进入任务草稿并打开内置终端，通过真实 Host 终端服务执行命令生成校验文件，Renderer 无 `pageerror`。登录页与本地工作区截图已检查。没有真实登录、充值或发起付费模型请求。

证据：`logs/mac-verification/dmg-verification.json`、`logs/mac-dmg-verification.log`、`logs/mac-startup-final.log` 和 `output/playwright/milo-packaged-20261113/{result.json,login.png,local-workspace.png}`。CLI 当前源码产物、macOS 和 Windows staging 的 SHA256 一致：`cb0f516f3ce596fe9175e5169beb2a872c91ec18df049e841698e1cadd77f21b`。

Windows 最终构建退出0，运行时依赖闭包和500 MiB包体门禁通过。实际交付 EXE 的 NSIS 外层及其嵌入的 `app-64.7z` 完整性检查通过；从安装器选择性解包验证的主程序、pty/conpty/winpty、ripgrep/ugrep、koffi 均为 PE x64（`0x8664`），内嵌 CLI 与当前源码 SHA 一致，应用身份、生产 origin、平台元数据和运行身份修复均通过。证据为 `logs/win-x64-installer-verify.json`、同名 `.log`，可复跑脚本为 `logs/verify-windows-installer.py`。本机没有 Windows 运行环境，未做 Windows 安装/运行验收。

最终产物均在 `packages/desktop/dist-milo-20261113/`，版本 `3.17.2`：

| 产物                                      | 大小                           | SHA256                                                             |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `win-x64/MiloCode-3.17.2-win-x64.exe`     | 198,419,938 bytes（189.2 MiB） | `a91319523270ffd86aaafa008725feb271c68cd776aaaa030363a88095b6eb50` |
| `mac-arm64/MiloCode-3.17.2-mac-arm64.dmg` | 236,088,208 bytes（225.2 MiB） | `cecd7c67a88f57c80ee5421181694d78cf2373e7bcf29e89c43dfb3ab71e053e` |
| `mac-arm64/MiloCode-3.17.2-mac-arm64.zip` | 228,360,859 bytes（217.8 MiB） | `0f13d8ad010d47c9b336d0af2687805a12d06f2a964ba685b51d0a08c6a86863` |

macOS 内部可执行文件保留 linker ad-hoc 标记，`TeamIdentifier` 未设置；这不构成发行证书签名或公证。Windows 同样未配置发行证书。本轮仅生成本地安装包，不创建远端发行版、不推送代码；保留用户原有工作区变更。临时解包和启动副本清理，保留交付安装包、摘要、日志、截图与验证脚本。

## 安装包运行身份规则与回归

首轮真实 macOS 安装包验收确认：`app.isPackaged=true`，但 `app.getName()` 为旧的 `ZCode`。原因是构建身份已改为 MiloCode，`desktopRuntimeEnv.runtimeApplicationName` 仍独立维护旧名称，随后 Main 的 `app.setName` 覆盖安装包身份；默认 Electron userData/session 路径同样使用该名称。

运行身份只复用现有 `desktop-product-identity.mjs` 的产品身份定义，不新增独立状态或产品名表。打包运行按编译期 flavor 得到 `MiloCode` / `MiloCode Preview`，不根据用户机器上的 `ZCODE_ENV` 重新判定；本地开发继续 `ZCode Dev`，显式 `ZCODE_DESKTOP_APPLICATION_NAME` 非空覆盖仍优先。默认 Electron userData 跟随最终运行名称，显式 userData/session 覆盖保持原语义；本轮不迁移、不修改业务 `.zcode` 数据目录。

验收先在现有 `desktopProductIdentity` 工程测试中导入真实 `desktopRuntimeEnv`，替换 Electron 外壳和编译期 flavor，覆盖正式/Preview、开发、显式覆盖与默认 userData 的关系；保留修前失败证据。修复后由父任务重新构建安装包并补做实际 packaged 启动，不能用纯 resolver 测试代替安装包身份验收。

工程回归已按上述方式完成：修前3项分别稳定返回旧名称，修后现有套件 **14/14通过**，证据在 `logs/runtime-identity-red.log`、`runtime-identity-green.log`。实现及手写 `.d.mts` 声明同步，单模块 Main 与全量类型检查均通过（`logs/typecheck.log`）；架构0违规，全量Lint84条既有警告/0错误，目标格式与差异检查通过。最终重新打包的实际运行身份已通过上面的 macOS 启动验收。
