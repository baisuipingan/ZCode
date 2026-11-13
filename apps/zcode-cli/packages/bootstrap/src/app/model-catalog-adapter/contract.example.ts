import { createModelCatalogPort } from "../model-catalog-port.js";
import type { ModelCatalogAdapterDependencies } from "./contract.js";

/** 同一适配器可反复列举；每次都从依赖读取当前事实，不复用构造期快照。 */
export function exampleListConfiguredModels(dependencies: ModelCatalogAdapterDependencies) {
  const catalog = createModelCatalogPort(dependencies);
  return catalog.listModels();
}
