import { useEffect } from "react";

interface ErrorToastProps {
  message: string | null;
  onDismiss: () => void;
  action?: { label: string; onClick: () => void };
}

const AUTO_DISMISS_MS = 6000;

export default function ErrorToast({ message, onDismiss, action }: ErrorToastProps) {
  useEffect(() => {
    if (message === null) {
      window.electronAPI?.expandRail(false);
      return;
    }

    window.electronAPI?.expandRail(true);

    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (message === null) return null;

  return (
    <div className="flex-1 flex flex-col gap-1.5 px-3 py-2 text-xs bg-panel border border-signal rounded-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="flex-1">{message}</span>
        <button
          aria-label="close"
          onClick={onDismiss}
          className="text-dim hover:text-phosphor focus:outline-none shrink-0"
        >
          [x]
        </button>
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="self-start px-2 py-0.5 rounded-sm border border-signal text-signal hover:bg-signal hover:text-void transition focus:outline-none focus:ring-2 focus:ring-signal"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
