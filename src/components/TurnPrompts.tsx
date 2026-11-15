import { PermissionCard, type PermissionDecision } from "@/components/PermissionCard";
import { QuestionPrompt } from "@/components/QuestionPrompt";
import type { AskAnswer } from "@/lib/agentTools";
import { useTranslations } from "@/lib/i18n";
import type { PendingApproval, PendingQuestion } from "@/lib/usePermissionPrompts";
import { cn } from "@/lib/utils";

interface TurnPromptsProps {
  widthClass: string;
  /** A plan written in plan mode, waiting to be applied. */
  planReady: boolean;
  onApplyPlan: () => void;
  /** The open chat's permission requests; the oldest shows, the rest count as queued. */
  pending: PendingApproval[];
  onRespondPermission: (decision: PermissionDecision) => void;
  question: PendingQuestion | null;
  onAnswerQuestion: (answers: AskAnswer[] | null) => void;
}

/** What sits between the chat and its message box while a turn needs the user: a plan ready
 *  to apply, a permission to grant or a question to answer. */
export function TurnPrompts({
  widthClass,
  planReady,
  onApplyPlan,
  pending,
  onRespondPermission,
  question,
  onAnswerQuestion,
}: TurnPromptsProps) {
  const tApp = useTranslations().app;
  return (
    <>
      {planReady && (
        <div className="px-4">
          <div className={cn(widthClass, "mx-auto mb-2 flex items-center justify-between gap-3 rounded-[8px] border border-bg-300 bg-bg-100 p-3 animate-fade-in")}>
            <span className="text-sm text-text-200">{tApp.planReady}</span>
            <button onClick={onApplyPlan} className="px-3 py-1.5 rounded-[6px] text-xs font-medium bg-accent text-bg-0 hover:bg-accent-hover">{tApp.applyPlan}</button>
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <div className="px-4">
          <div className={cn(widthClass, "mx-auto mb-2")}>
            <PermissionCard
              key={pending[0].id}
              toolName={pending[0].toolName}
              input={pending[0].input}
              label={pending[0].label}
              queued={pending.length - 1}
              onRespond={onRespondPermission}
            />
          </div>
        </div>
      )}
      {question && (
        <div className="px-4">
          <div className={cn(widthClass, "mx-auto")}>
            <QuestionPrompt
              key={question.id}
              questions={question.questions}
              onAnswer={onAnswerQuestion}
              onDismiss={() => onAnswerQuestion(null)}
            />
          </div>
        </div>
      )}
    </>
  );
}
