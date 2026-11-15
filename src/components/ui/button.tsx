import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-bg-0 hover:bg-accent-hover focus-visible:ring-accent",
  secondary: "border border-bg-300 bg-bg-0 text-text-100 hover:bg-bg-200 focus-visible:ring-accent",
  ghost: "text-text-300 hover:text-text-100 hover:bg-bg-200 focus-visible:ring-accent",
  danger: "bg-red-600 text-white hover:bg-red-500 focus-visible:ring-red-500",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** A square button holding only an icon; give it an `aria-label`. */
  icon?: boolean;
}

/** The app's button: 6px corners, a 28px row, and a focus ring for the keyboard. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", icon = false, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[6px] text-[13px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-100",
        "disabled:pointer-events-none disabled:opacity-50",
        icon ? "h-7 w-7" : "h-7 px-3",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});
