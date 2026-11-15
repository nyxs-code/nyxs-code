import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Nyxs] UI crashed:", error, info.componentStack);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fixed inset-0 z-[999] flex items-center justify-center bg-bg-0 p-6 overflow-auto">
        <div className="w-full max-w-2xl rounded-[8px] border border-red-500/30 bg-bg-100 p-6 shadow-2xl">
          <h1 className="text-lg font-semibold text-red-400">Something broke in the UI</h1>
          <p className="mt-1 text-[13px] text-text-400">
            The interface hit a render error. Reload to recover; the details below help diagnose it.
          </p>
          <pre className="mt-3 max-h-48 overflow-auto rounded-md border border-bg-300 bg-bg-200 p-3 text-[12px] font-mono text-red-300 whitespace-pre-wrap break-words">
            {error.message}
            {"\n\n"}
            {error.stack}
          </pre>
          {info?.componentStack && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-bg-300 bg-bg-200 p-3 text-[11px] font-mono text-text-400 whitespace-pre-wrap break-words">
              {info.componentStack}
            </pre>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-accent px-3.5 py-2 text-[13px] font-medium text-bg-0 hover:bg-accent-hover"
            >
              Reload app
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null, info: null })}
              className="rounded-md border border-bg-300 px-3.5 py-2 text-[13px] font-medium text-text-200 hover:bg-bg-200"
            >
              Try to continue
            </button>
          </div>
        </div>
      </div>
    );
  }
}
