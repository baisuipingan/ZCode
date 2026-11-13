import miloLogoUrl from "@/assets/milo-logo.png";
import { cn } from "@/components/lib/utils.js";

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <img
      src={miloLogoUrl}
      className={cn("shrink-0", className)}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <img
      src={miloLogoUrl}
      // 小尺寸深蓝图形在深色主题加轻微轮廓，避免与背景混在一起。
      className={cn(
        "shrink-0 dark:drop-shadow-[0_0_0.6px_rgba(255,255,255,0.75)]",
        className,
      )}
      alt="MiloCode"
      draggable={false}
    />
  );
}
