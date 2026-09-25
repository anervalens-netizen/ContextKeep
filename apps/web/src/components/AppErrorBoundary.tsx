import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally do not touch IndexedDB, the offline queue or server state.
    // Route recovery is a render concern only.
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <section
        role="alert"
        className="rounded-2xl border border-ck-red/30 bg-ck-surface p-4 text-sm"
        data-testid="app-error-boundary"
      >
        <h2 className="font-semibold text-ck-ink">This view could not be rendered.</h2>
        <p className="mt-1 text-xs text-ck-muted">
          ContextKeep did not clear or discard the offline mutation queue. You can retry the view or reload the app safely.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={this.retry}
            className="rounded-lg border border-ck-line px-3 py-2 text-xs font-semibold text-ck-ink"
          >
            Try view again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-ck-line px-3 py-2 text-xs font-semibold text-ck-muted"
          >
            Reload app
          </button>
        </div>
      </section>
    );
  }
}
