import { useEffect } from "react";

interface ErrorToastProps {
  message: string | null;
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 6000;

export default function ErrorToast({ message, onDismiss }: ErrorToastProps) {
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
    <div className="flex-1 flex items-start justify-between gap-2 px-3 py-2 text-xs bg-panel border border-signal rounded-sm">
      <span>{message}</span>
      <button
        aria-label="close"
        onClick={onDismiss}
        className="text-signal hover:underline focus:outline-none shrink-0"
      >
        [x]
      </button>
    </div>
  );
}
