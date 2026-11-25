import { useState } from "react";
import { CircleCheck, Pencil, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatGoal } from "@/lib/goal";
import { useGoalChecking } from "@/lib/goalMode";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const SPARKS = [0, 45, 90, 135, 180, 225, 270, 315];

/** The goal set with `/goal`, above the composer. While the agent works toward it a light runs
 *  around the border and the status shimmers; once met the border turns green and sparks fly
 *  from the icon. Edit puts `/goal …` back in the composer; the X clears it. */
export function GoalCard({
  chatId,
  goal,
  working,
  onEdit,
  onClear,
}: {
  chatId: string;
  goal: ChatGoal;
  /** A turn runs in the chat. */
  working: boolean;
  onEdit: () => void;
  onClear: () => void;
}) {
  const t = useTranslations().goal;
  const checking = useGoalChecking(chatId);
  const met = goal.status === "met";
  const live = !met && goal.status === "active" && (working || checking);

  // The sparks fly when the goal is met while the card is on screen, not when a met goal shows up.
  const [seen, setSeen] = useState(goal.status);
  const [burst, setBurst] = useState(false);
  if (seen !== goal.status) {
    setSeen(goal.status);
    setBurst(goal.status === "met");
  }

  const turns = (n: number) => (n === 1 ? t.turnsOne : t.turnsMany.replace("{count}", String(n)));
  let status: string;
  if (met) status = goal.turns === 1 ? t.achievedOne : t.achievedMany.replace("{count}", String(goal.turns));
  else if (checking) status = t.checking;
  else if (goal.status === "paused") {
    status =
      goal.pausedBy === "limit"
        ? t.pausedByLimit.replace("{count}", String(goal.turns))
        : goal.pausedBy === "error"
          ? t.pausedByError
          : goal.pausedBy === "unchecked"
            ? t.unchecked
            : t.pausedByUser;
  } else if (goal.turns === 0) status = t.notChecked;
  else status = goal.lastReason ? `${turns(goal.turns)} · ${t.lastCheck.replace("{reason}", goal.lastReason)}` : turns(goal.turns);

  return (
    <div
      role="group"
      aria-label={t.cardLabel}
      className={cn("goal-card relative z-0 mx-2 md:mx-0 mb-2 rounded-[8px] p-[1.5px]", live && "goal-card-live", met ? "bg-success" : !live && "bg-bg-300/70")}
    >
      <div className="relative flex items-center gap-3 rounded-[7px] bg-bg-200 py-1.5 pl-3 pr-1.5">
        <span className="relative h-[22px] w-[22px] shrink-0">
          <Target className={cn("absolute inset-0 h-[22px] w-[22px] text-accent transition-all duration-200", met && "scale-50 opacity-0")} aria-hidden />
          <CircleCheck className={cn("goal-check absolute inset-0 h-[22px] w-[22px] text-success", met ? "goal-check-on" : "scale-50 opacity-0")} aria-hidden />
          {burst &&
            SPARKS.map((r) => <i key={r} className="goal-spark" style={{ "--r": `${r}deg` } as React.CSSProperties} onAnimationEnd={r === 0 ? () => setBurst(false) : undefined} />)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug text-text-100 [overflow-wrap:anywhere]">{goal.text}</p>
          <p className={cn("mt-0.5 truncate text-[12px]", met ? "text-success" : live ? "goal-shimmer" : "text-text-400")} role="status">
            {status}
          </p>
        </div>
        {!met && (
          <Button variant="ghost" icon onClick={onEdit} aria-label={t.edit} data-tooltip={t.edit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" icon onClick={onClear} aria-label={t.clear} data-tooltip={t.clear}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
