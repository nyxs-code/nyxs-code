import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogTitle } from "@/components/ui/dialog";

interface ConfirmDialogProps {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Leave it out for a notice that only needs acknowledging. */
  cancelLabel?: string;
  danger?: boolean;
  /** A second way to go ahead, between cancel and confirm ("Delete 3 sessions" beside "Delete
   *  this session"). */
  alternative?: { label: string; onClick: () => void };
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  alternative,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  return (
    <Dialog
      open
      onClose={onCancel}
      role="alertdialog"
      describedBy={message ? messageId : undefined}
      initialFocus={confirmRef}
      stacked
      className={alternative ? "max-w-md" : "max-w-sm"}
    >
      <div className="px-4 pt-4">
        <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
        {message && (
          <p id={messageId} className="mt-2 text-[13px] leading-relaxed text-text-300 break-words">
            {message}
          </p>
        )}
      </div>
      <DialogFooter>
        {cancelLabel && (
          <Button variant={alternative ? "ghost" : "secondary"} className={alternative ? "mr-auto" : undefined} onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
        {alternative && <Button onClick={alternative.onClick}>{alternative.label}</Button>}
        <Button ref={confirmRef} variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export type ConfirmOptions = Omit<ConfirmDialogProps, "onConfirm" | "onCancel">;
