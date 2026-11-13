import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderRegistryView } from "@zcode/provider";

// 复用已有工具端口，不另建模型目录或维护第二份模型集合。
export type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";

/** 同步只读适配所需的最窄输入；Registry 与会话仍各自拥有其状态。 */
export interface ModelCatalogAdapterDependencies {
  /** 每次列举现读已配置 Registry；此接口不允许修改、刷新或访问网络。 */
  registry: { getView(): ProviderRegistryView };
  /** 每次列举现读当前会话选择，只用于标记 current。 */
  currentSelection(): ModelSelection | undefined;
}
