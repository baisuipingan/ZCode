import type { Locale } from "@zcode/shared";
import type { CuaOperationIndicatorContentContract } from "./contract.js";

/** 装配方复用现有函数；窗口创建、显示和隐藏继续由调用方负责。 */
export function exampleCuaOperationIndicatorContent(
  content: CuaOperationIndicatorContentContract,
  locale: Locale,
) {
  return {
    ...content.indicatorWindowSize(locale),
    url: content.indicatorDataUrl(locale),
  };
}
