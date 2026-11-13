# CUA 操作提示条静态呈现

`windowsCuaOperationIndicatorContent.ts` 是既有 Windows 操作提示条的唯一文案、尺寸、HTML 与 data URL 来源。本模块仅登记这一静态呈现边界，不新增转发实现。

所有函数由 locale 决定结果，不读屏幕、不访问网络、不持有可变状态。HTML 只含内联样式和已经转义的本地文案，深浅色由 `prefers-color-scheme` 决定，缩减动画跟随系统设置。

现有 `windowsCuaOperationIndicator.ts` 继续拥有 Electron 窗口、活动会话集合、显示/隐藏、释放和所有计时器；调用现有导出即可，不经本模块重新建立生命周期。

展示变更用浏览器验收中英文、浅深色下的文案完整性和卡片尺寸。Computer Use 占位包不可用时，本模块不会使该能力变为可用。
