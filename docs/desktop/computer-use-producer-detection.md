# Computer Use producer 检测

## 规则

`zcodeCuaPlaceholder` 只判定上游私有 Helper producer。MiloCode 在同包新增独立的
`computerUseProvider: "agent-desktop"`，使用 Vercel agent-desktop v1.3.1。
旧 Helper 接口继续占位，不能把 `zcodeCuaPlaceholder` 改成 false 来启用新执行器。

包保留公共 runtime/broker 类型契约；新执行器经可信 Node REPL broker 调用。
资源准备由 `packages/desktop/scripts/agent-desktop/` 独立管理，不触发旧 Helper 的构建/安装流程。

以下开发、构建与打包中只服务于旧私有 Helper 的步骤，必须先检测到真实 producer 才执行；
检测不到时跳过，不能让开源树的入口因为缺少私有产物而失败：

| 步骤                                                                   | 位置                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 开发启动构建 macOS Helper、注入 Helper 环境变量                        | `scripts/dev-desktop-env.mjs`                         |
| 开发态暂存 Computer Use 插件的原生依赖（Sharp）                        | `scripts/stage-dev-cua-plugin-runtime.mjs`            |
| Windows 运行时资源准备 `prepare:windows-cua-helper`                    | `packages/desktop/scripts/prepare-runtime-assets.mjs` |
| 打包附带 macOS Helper、Windows Helper 资源，打包后的 Helper 校验与定稿 | `packages/desktop/electron-builder.config.js`         |

Sharp 的暂存与校验仍以“producer 是否声明 Sharp 依赖”为准（`isSharpRequiredByComputerUse`），
与本检测一致：真实 producer 声明 Sharp，占位包不声明。

## 所有者与接口

- 唯一判定：`packages/desktop/scripts/computer-use-producer.mjs` 的 `readComputerUseProducer` /
  `isRealComputerUseProducerInstalled`。从桌面包目录向上查找最近一次安装的 `@zcode/zcode-cua`，
  读取清单的 `zcodeCuaPlaceholder` 字段。
- 构建配置同步求值，判定只做一次小文件同步读取。

## 验收

1. 闭源（真实 producer）：上述步骤行为不变。
2. 旧 Helper 占位包：`pnpm dev:desktop` 的准备脚本可加载，开发态插件运行时暂存返回空，Windows 不准备 Helper，
   打包不附带也不校验 Helper。
3. Vercel provider：固定资源下载与 SHA-256 验证独立执行；包内必须同时包含 Mac CLI 与伴随 helper，Windows 包含 exe。新执行器 CUA 回归、资源工程测试和 UI 验收见 [接入规格](../fork/39-computer-use-agent-desktop.md)。
