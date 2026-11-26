import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, X } from "lucide-react";
import { ImageAnnotator } from "@/components/ImageAnnotator";
import { attachToComposer, canAttachToComposer } from "@/lib/composerAttach";
import { useTranslations } from "@/lib/i18n";
import { useShownOverNativeViews } from "@/lib/nativeViews";
import { cn } from "@/lib/utils";

const BUTTON = "p-2 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors";

export function ImageLightbox({
  src,
  alt,
  onClose,
  onSave,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
  /** The image is one the user can change (an attachment in the message box): the drawn copy
   *  replaces it instead of being added to the message as another image. */
  onSave?: (file: File) => void;
}) {
  const t = useTranslations().changelog;
  const tx = useTranslations().messageExtra;
  const [annotating, setAnnotating] = useState(false);
  // Over a website in the browser panel it stays invisible until the page has stepped aside,
  // like Dialog; otherwise it would show behind the page for a moment.
  const visible = useShownOverNativeViews(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape leaves the drawing tools first, then the viewer.
      if (annotating) setAnnotating(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, annotating]);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[100] flex items-center justify-center bg-black/70",
        visible ? "animate-fade-in" : "opacity-0",
      )}
      onClick={annotating ? undefined : onClose}
    >
      {annotating ? (
        <>
          <button onClick={onClose} aria-label={t.close} className={cn("absolute top-4 right-4", BUTTON)}>
            <X className="w-5 h-5" />
          </button>
          <ImageAnnotator
            src={src}
            name={alt ?? "image"}
            onClose={() => setAnnotating(false)}
            saveLabel={onSave ? tx.saveAnnotations : undefined}
            onDone={(file) => {
              if (onSave) onSave(file);
              else attachToComposer([file]);
              onClose();
            }}
          />
        </>
      ) : (
        // As in Claude's app: close and draw sit just right of the image, from its top edge down.
        // The image leaves room for them on both sides so the pair stays inside the window.
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <img
            src={src}
            alt={alt ?? "image"}
            className="block max-w-[calc(100vw-128px)] max-h-[90vh] object-contain rounded-lg shadow-2xl"
          />
          <div className="absolute left-full top-0 ml-2 flex flex-col items-center gap-1">
            <button onClick={onClose} aria-label={t.close} className={BUTTON}>
              <X className="w-5 h-5" />
            </button>
            {(onSave || canAttachToComposer()) && (
              <button
                onClick={() => setAnnotating(true)}
                aria-label={tx.annotateImage}
                data-tooltip={tx.annotateImage}
                data-tooltip-side="right"
                className={BUTTON}
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

export default ImageLightbox;
