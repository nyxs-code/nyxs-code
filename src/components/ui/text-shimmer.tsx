import { createElement, type CSSProperties, type ElementType } from "react";
import { cn } from "@/lib/utils";

export function TextShimmer({
  children,
  as = "span",
  className,
  duration = 2,
  spread = 2,
}: {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}) {
  return createElement(
    as,
    {
      className: cn("text-shimmer", className),
      style: {
        "--shimmer-spread": `${children.length * spread}px`,
        "--shimmer-duration": `${duration}s`,
      } as CSSProperties,
    },
    children,
  );
}
