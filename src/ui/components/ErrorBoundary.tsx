import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  // Resetting this prop (e.g. to the current page id) clears a caught error
  // once the boundary is no longer the active/visible page.
  resetKey?: unknown;
};

type State = {
  error: Error | null;
};

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
          <p className="text-xs text-dim">This page hit an unexpected error.</p>
          <p className="text-xs text-red-400 break-all">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
