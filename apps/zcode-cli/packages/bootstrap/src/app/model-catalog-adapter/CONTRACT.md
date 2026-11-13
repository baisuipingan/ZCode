# CLI 模型目录适配器

将 Provider Registry 的当前执行集合投影为既有 `@zcode/contracts` 的 `ModelCatalogPort`，供 `ListModels` 与子 Agent 模型名解析读取。唯一创建入口仍为相邻的 `model-catalog-port.ts`；源码位置和执行链不变。

- Registry 拥有模型与能力，会话拥有当前选择；适配器无业务状态、缓存、写入、网络或凭据访问。
- 每次 `listModels()` 同步现读 `getView()` 和 `currentSelection()`。只投影 Registry 现有成员，不添加模型、不跨供应商匹配或回落。
- 推理档位保留原顺序并复制数组；主模型默认优先 `defaultLevel`，缺省沿用旧最高档。辅助调用最低档由既有调用链管理，不在此适配器改写。
- 返回端口合同复用既有 `ModelCatalogPort`/`ModelCatalogEntry`，不复制工具 schema、改变工具权限或产生事件。
- 治理范围仅该适配器文件和本目录的契约产物。依赖为公开 Provider Registry 类型、共享模型选择类型及既有 CLI 端口；不纳入模型执行器或整个 bootstrap app。
