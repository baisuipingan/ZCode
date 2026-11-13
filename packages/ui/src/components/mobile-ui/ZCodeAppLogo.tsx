import type { ZCodeAppLogoProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";
import appLogoUrl from "@/assets/milo-logo.png";

/**
 * 与桌面端标题栏共用 MiloCode 应用图，避免手机远控仍显示上游应用品牌。
 * 装饰性图片：调用方负责在旁边给出可读的品牌文字，避免屏幕阅读器重复朗读。
 */
export function ZCodeAppLogo({ className }: ZCodeAppLogoProps) {
  return (
    <img
      src={appLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      // 稳定的测试/E2E 钩子：打包器可能把 SVG 内联为 data URL，不能靠文件名断言。
      data-app-logo="zcode"
      // 深蓝品牌图在深色小尺寸背景上对比偏低；细轮廓保留原图色彩和布局。
      className={cn(
        "shrink-0 select-none object-contain dark:drop-shadow-[0_0_0.6px_rgba(255,255,255,0.75)]",
        className,
      )}
    />
  );
}
