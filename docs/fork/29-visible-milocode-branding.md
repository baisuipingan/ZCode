# MiloCode 可见品牌一致性

2026-11-13。本轮延续28号启动与登录修复，将自家客户端面向用户的产品名称统一为 **MiloCode**。品牌替换只发生在展示边界，不改变产品行为或兼容标识。

## 展示规则与边界

- 中英文登录说明、窗口标题、权限弹窗、更新提示、应用操作菜单、侧栏缺省名称、反馈中的Agent展示名称统一为 MiloCode。
- 手机/远控应用Logo及更新日志的产品标记复用现有 `milo-logo.png`，不改模型供应商图标。
- 小尺寸应用Logo在深色背景加轻微浅色轮廓阴影，避免原图深蓝主体与背景混在一起；不改变原图、颜色或占用尺寸，浅色主题不加此效果。
- 自家功能生成的推荐提示、应用内展示的技能描述与异常缺省提示使用 MiloCode；官方插件的实际名称、来源和第三方署名保持准确，不将外部项目改称自家产品。
- 内部包名、类型、错误码和协议匹配哨兵、URL scheme、HTTP头、环境变量、设置key、`.zcode`业务数据路径、注册键、旧版本迁移目录保持原有标识。系统菜单的显示标签与这些兼容标识分开处理。
- Linux桌面入口的 `Comment` 新写入为 `MiloCode Desktop App`；归属识别同时接受原有 `Comment=ZCode Desktop App`，确保仍能清理旧条目且不删除用户自定义入口。Finder工作流原有文件名保留，仅更新服务菜单显示标签，避免留下重复的系统服务。
- 不引入新的品牌设置或状态owner。既有React、Main、Host分别继续拥有原有UI和平台职责；仅替换其自身展示文案，不新增跨层调用或第二条读写路径。
- `cua-operation-indicator-content` 仅登记既有 Windows CUA 提示条的静态 HTML、文案和尺寸呈现边界；生命周期、活动会话集合、计时器与 Electron 窗口仍由原 `windowsCuaOperationIndicator.ts` 持有，不移入或重新实现。
- 当前 `@zcode/zcode-cua` 是明确不可用的开源占位包。本轮只更新其 `HELPER_DISPLAY_NAME` 展示常量；安装目录、app 文件名、bundle ID、协议和可信归属保留。占位包不会安装或启动真实 Helper，因此不声称修改了系统权限列表中的实际签名身份。
- `officeSuggestedPrompts.ts` 已无生产导入，当前推荐入口使用 `featureSuggestedPrompts.ts`。不为无效旧内容引入新的架构模块或品牌改动。

## 验收范围

先从TypeScript语法树提取UI/桌面的字符串与JSX文案，逐项区分产品展示、协议标识和外部资源。改后重复审计，保留明确的兼容与第三方例外。

本轮是展示文案变更，不增加App业务单测、不构建安装包、不发真实模型请求。使用本地浏览器检查中英文Windows电脑操作提示条在浅深色下的完整显示；运行现有必要浏览器场景，并由父任务统一执行全局typecheck/lint。结构检查在改前和改后各运行一次；通过只表示已配置规则未报错，不将unmanaged模块的空context当作完整架构证明。

复审确认远端任务服务缺少 `onDynamicTaskReady` 或返回不可订阅结果时，两条异常只用于故障展示，无其他源码按完整文案匹配，故展示名称改为 MiloCode。`ZCode agent transport closed`、`ZCode Protocol client disposed` 等已有错误分类哨兵继续保留，避免改变识别行为。
