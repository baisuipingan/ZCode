# Windows 安装器工具链修复

2026-11-14，用户反馈正式 Windows 3.17.3 安装器在 Windows 11 x64 上启动即退出，事件记录为 `0xc0000005`；未获得 faulting module、偏移或 dump，不把该异常码当成唯一根因。

## 已确认的缺陷与证据

- Windows 产物确实是 NSIS 向导安装器，`oneClick=false`，不是 portable。正式包包含 `$PLUGINSDIR/app-64.7z`。
- `output/milocode-3.17.3-win-async-package.log` 记录实际使用 `dist-milo-20261113/logs/nsis-native-arm64`。该入口设置 `NSISDIR` 为 builder 的 3.0.4.1 目录，再执行 Homebrew 3.12 `makensis`，混用了编译器与 Windows runtime stub。NSIS [官方文档](https://nsis.sourceforge.io/Docs/AppendixG.html)要求二者源码、配置、文件格式完全一致。
- 进一步核对最终 PE 和实际机器码：编译器按 1,024 字符分配变量区，旧 stub 按 8,192 字符寻址；初始化 `$CMDLINE` 访问 `0x4cb000`，映像实际止于 `0x4c6000`，启动即越界。`output/windows-installer-crash-audit/entrypoint-abi-comparison.json` 保存旧最终包、最小混用包及两套一致工具链的四组对照。`7-Zip BadCmd=13` 同样出现在正常对照包中，不能作为损坏判据。
- 3.17.3 安装器及其内部应用的 7 个 PE 图标帧与 Git HEAD 旧 ZCode ICO 完全一致。新白底 Milo 图标仅在工作区，尚未进入正式包；不是仅由图标缓存造成。
- 旧验收只覆盖解包、哈希、架构和内容，没有运行最终 Windows EXE。编译或解包成功不能证明安装器可执行。

## 修复规则

1. 继续使用现有 NSIS 向导、安装路径选择、更新信任和文件保护逻辑，不更换安装技术或修改客户端业务逻辑。
2. 使用当前 electron-builder 26.17.0 已支持且校验摘要的 `toolsets.nsis=1.2.1` 官方完整套装（NSIS 3.12）。不升级项目依赖，不混用 Homebrew 编译器与旧 stub/include/plugin。
3. Windows 构建若有非空 `ELECTRON_BUILDER_NSIS_DIR`、`ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 或 `NSISDIR` 覆盖，直接失败并提示移除，不能静默清空或回退旧目录。Mac/Linux 构建不受该约束影响。
4. 安装器、卸载器、内嵌应用使用当前白底 Milo 图标。客户端内部 Logo 保持原样；不关闭 PE 资源编辑来绕开无证书构建。
5. 工程回归覆盖真实 config 的统一工具链配置、Windows 覆盖阻断与 Mac 边界；独立校验最终 EXE 的图标与内包。
6. 修复候选只在本地验证，不覆盖已发布 3.17.3 字节。正式发布需递增版本，且运行最终 EXE 验证安装界面、安装后应用及卸载流程；若缺少 Windows 环境，明确标记待验收。

## 完整工具链的插件注册顺序

NSIS 3.12 统一套装包含内置和扩展插件。Builder 先 include `installer.nsh`，再注册完整插件目录；旧脚本三个日志/快捷方式函数在 include 时已经使用 `System`/`nsExec`。3.12 随后重新扫描已使用的插件会报冲突，即使目录完全相同也如此；最小对照证明抢先注册相同目录不能解决。

仅把 `ZCodeWriteUninstallerLog`、`ZCodeWriteInstallerLog`、`ZCodeReadShortcutTarget` 三个函数的**编译定义**延迟到既有 `customHeader`，在插件目录注册后展开；保留函数体、调用顺序、日志、安装/卸载语义。安装器和卸载器分别展开自己的函数，既有真实 fixture 两种构建均调用 `customHeader`，与 Builder 正式模板一致。不得用替换旧 stub、删除系统插件或关闭警告来规避。

本地候选使用既有 3.17.3 编译产物及相同 CLI，验证工具链和系统图标；不将尚未编译的远程模型档案业务改动混入此候选。候选带 `local-repair` 文件名，仅供 Windows 验收。

## 验证记录

- 本地完整候选构建退出 0，`candidate-build-final.log` 确认 NSIS 向导模式、官方统一 1.2.1 及 blockmap。候选路径：`packages/desktop/dist-milo-windows-repair-20261114/MiloCode-3.17.3-win-x64-local-repair.exe`，198,172,985 bytes，SHA256 `eca652a39808dfd64af54356eee25fd63b98d9ff8ecbe85c68980eb30c06e2b4`。保留已发布 3.17.3 原文件，未发布或更新 stable。
- 最终 EXE 的 compiler/runtime 均为 8,192 字符；`.ndata` 1,916,928 bytes，`$CMDLINE` 和 `$TEMP` 均位于有效变量区及映像内。证据：`output/windows-installer-audit/candidate-memory-layout.json`。
- 安装器、内嵌 `MiloCode.exe` 的全部 7 个图标帧逐字节匹配新白底图标。证据：`candidate-icons.json`。内部启动 Logo 通过原有 ASAR 校验，仍与原素材一致。
- 最终包离线内外归档、CLI 三方 SHA、11 项调用归属、9 项 x64 资源、品牌/回调/异步安全存储静态路径及更新信任策略检查通过。证据：`acceptance/windows-installer-verification.json`。更新公钥与冻结的已发布 3.17.3 DER SHA256 比对，不读取本机发布私钥；旧 inspector 的本机公钥文件路径已不存在，调整仅位于本轮 output 副本。原失败日志保留。
- 工程测试 26/26 通过；工具链配置修前 4 项失败、修后通过的记录均保留。真实安装器和卸载器 fixture 在统一套装下均 `-WX` 编译通过，无警告；三处函数正文与 HEAD 逐字一致。未将编译当成运行验证。
- 全项目 typecheck 通过；lint 0 errors / 84 条既有 warnings；架构 0 违规，`git diff --check` 通过。额外格式检查在两个既有文件失败；用相同格式器比较 HEAD 已确认原文件本来就存在格式差异，未对整份配置和测试做无关格式重写。
- 候选使用仓库锁定 Node 24.14.0 / pnpm 10.33.2，子进程 PATH 同样固定 pnpm 10。首次直接 Node 启动误识别 npm，第二次子进程拾取全局 pnpm 11，均由缺依赖门禁阻断；未关闭 `allowMissingDependencies` 或重装依赖。后续统一工具链暴露的插件注册顺序冲突按上文修复，原失败证据保留。
- 本机无 Windows 环境，**最终 EXE 的向导显示、安装、安装后启动及卸载尚待 Windows 实机验收**。普通交互诊断脚本位于 `output/windows-installer-audit/Invoke-MiloCodeInstallerAudit.ps1`，只启动并收集事件，不自动安装、提权或更改安全策略；该脚本也未在 Windows 执行。
- 清理本轮可再生 `win-unpacked` 暂存目录，保留正式旧包、本地候选、blockmap、日志及回归证据。

## 正式 Windows 安装包运行门禁

正式 3.17.4 发布增加 `scripts/windows-installer-acceptance.ps1` 和独立 GitHub Windows 2025 runner。验收直接下载 `baisuipingan/ZCode` 的 Draft Release `milocode-v3.17.4` 中的最终 `MiloCode-3.17.4-win-x64.exe`，不在 runner 重构建，不将本地候选当作正式包。发布者先上传最终字节，再把 SHA256 写入根目录 `windows-installer-acceptance.json` 后推送；缺失或不匹配的摘要立即失败。手动触发可显式提供同版本 SHA256。

事件和状态只有验收脚本一个 owner，结果按序写入 JSON；任一步失败都不能产生通过标记：

```text
固定 Release 资产 → 核对 SHA256/PE 版本 → 启动向导并记录可见控件/截图
  → 关闭本次向导进程 → /S /currentuser /D=<RUNNER_TEMP 隔离目录>
  → 安装退出 0/应用与卸载器/指向本次 exe 的快捷方式
  → 隔离 userData、sessionData、home 和业务数据启动已安装应用
  → 本地 CDP 确认真实 renderer 的 document/root/交互元素已就绪并截图
  → 仅停止本次进程树 → 静默卸载退出 0/安装文件已删除
```

- 工作流仅在 `codex/desktop-managed-agent` 的验收脚本、该工作流或验收 manifest 变更时自动执行，也支持手动触发；权限仅 `contents: read`。只使用仓库 token 读取同仓库 Draft，不读取发布签名私钥或生产凭据，不安装依赖。
- 所有安装目录、验收输出及应用数据位于 `RUNNER_TEMP`。安装使用当前用户模式，不提权、不修改系统安全策略、不关闭 SmartScreen/Defender/UAC，不使用 `--no-sandbox` 或忽略完整性校验。
- 仅操纵由本次脚本启动且启动时间相符的进程及其后代，绝不按通用 `MiloCode`/`Electron` 名称全局杀进程。向导检查后终止本次尚未安装的进程树；静默安装、应用、卸载分别记录退出/阶段。
- CDP 只监听 loopback，随机端口。读取页面及截图，不登录用户、不调用模型、不构造生产数据。无窗口、页面崩溃、空白 root、超时和卸载不完整均失败；诊断产物使用 `always()` 上传。
- 自动验收覆盖 Windows runner 上的最终包可运行性，不代替真实用户机器的 SmartScreen 声誉、不同 DPI/语言和人工审美验收。未实际运行时只报告静态检查通过，不能报告安装通过。
