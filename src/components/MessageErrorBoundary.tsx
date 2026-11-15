import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";

interface Props {
  /** The message's raw text: what "Copy text" copies, and what makes it try again when it changes. */
  text: string;
  children: ReactNode;
}

interface State {
  failedOn: string | null;
}

/** One message that fails to render shows a notice in its place, instead of the whole app's
 *  error screen (main.tsx) taking the chat down with it. */
export class MessageErrorBoundary extends Component<Props, State> {
  state: State = { failedOn: null };

  static getDerivedStateFromError(): Partial<State> {
    // Which text failed is set in componentDidCatch; anything not null hides the children now.
    return { failedOn: "" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Nyxs] a message couldn't be rendered:", error, info.componentStack);
    this.setState({ failedOn: this.props.text });
  }

  componentDidUpdate(prev: Props) {
    // A message still being written may render fine once more of it has arrived.
    if (this.state.failedOn !== null && prev.text !== this.props.text) this.setState({ failedOn: null });
  }

  render() {
    return this.state.failedOn === null ? this.props.children : <MessageFallback text={this.props.text} />;
  }
}

function MessageFallback({ text }: { text: string }) {
  const t = useTranslations().messageFallback;
  return (
    <div className="my-3 flex items-center gap-2 text-[13px] text-text-300">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
      <span>{t.couldNotShow}</span>
      <Button className="h-6 px-2 text-[12px]" onClick={() => void navigator.clipboard.writeText(text).catch(() => undefined)}>
        {t.copyText}
      </Button>
    </div>
  );
}
