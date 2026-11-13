/** 既有呈现函数的类型契约；无窗口、定时器或会话状态。 */
export interface CuaOperationIndicatorContentContract {
  /** 本地化文案与卡片宽度；同一 locale 输入始终得到相同结果。 */
  indicatorCopy: typeof import("../windowsCuaOperationIndicatorContent.js").indicatorCopy;
  /** 含阴影留白的窗口尺寸；不读取屏幕或创建窗口。 */
  indicatorWindowSize: typeof import("../windowsCuaOperationIndicatorContent.js").indicatorWindowSize;
  /** 自包含 HTML；主题由 CSS 跟随系统，文案进行 HTML 转义。 */
  indicatorHtml: typeof import("../windowsCuaOperationIndicatorContent.js").indicatorHtml;
  /** 上述 HTML 的内联 URL；不执行网络或文件 IO。 */
  indicatorDataUrl: typeof import("../windowsCuaOperationIndicatorContent.js").indicatorDataUrl;
}
