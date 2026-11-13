# MiloCode Mac 更新装配

Sparkle 是检查、下载、签名验证和安装事务的唯一所有者。本模块只把原生事件投影到已有菜单，并把安装请求交给 Electron Main 的任务确认和退出屏障。Windows 继续使用既有 updater，不实例化本模块。

唯一入口 `createMiloCodeMacUpdater` 只加载正式安装包固定路径下的 Node-API 桥。构建期源或公钥缺失、平台不符、原生模块缺失时拒绝启动；不能回退到原 ZCode 更新源。真实源和公钥由包内 Info.plist 提供。

时序：Sparkle install-request(requestId) → Main confirmInstall → onBeforeInstall → resolveInstall(requestId, true)。同一请求在途时忽略重复回调；取消确认不关闭 Host，也不放行 continuation，之后同一请求可重新确认。错误或 dispose 使旧异步结果失效；已开始关闭 Host 后发生错误，由 Main 重启应用恢复服务。

菜单状态只是投影，不触发旧 React 更新窗口、不保存第二份下载队列或安装包。所有用户下载和安装交互属于 Sparkle 原生窗口。生产仅 stable、手动下载与安装。

可重复原生验收：`node packages/desktop/scripts/milocode-sparkle-smoke.mjs`，使用独立 fixture、测试密钥和 userData；不得替换真实安装或访问真实用户数据。
