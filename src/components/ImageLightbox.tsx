import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { useShownOverNativeViews } from "@/lib/nativeViews";
import { cn } from "@/lib/utils";

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const t = useTranslations().changelog;
  // Over a website in the browser panel it stays invisible until the page has stepped aside,
  // like Dialog; otherwise it would show behind the page for a moment.
  const visible = useShownOverNativeViews(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm",
        visible ? "animate-fade-in" : "opacity-0",
      )}
      onClick={onClose}
    >
      <button
        onClick={onClose}
        aria-label={t.close}
        className="absolute top-4 right-4 p-2 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
      >
        <X className="w-6 h-6" />
      </button>
      <img
        src={src}
        alt={alt ?? "image"}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
    </div>,
    document.body,
  );
}

export default ImageLightbox;
