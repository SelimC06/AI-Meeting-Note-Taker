interface Props {
  onOpenSettings: () => void;
}

export default function TitleBar({ onOpenSettings }: Props) {
  return (
    <div className="h-10 flex items-center justify-between bg-panel border-b border-line text-phosphor select-none [-webkit-app-region:drag] text-xs">
      <div className="flex items-center gap-3 px-3 [-webkit-app-region:no-drag]">
        <span className="font-semibold">
          $ deskrecap
        </span>
      </div>

      <div className="flex items-center gap-1 pr-1 [-webkit-app-region:no-drag]">
        <ToolButton label="Settings" onClick={onOpenSettings}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </ToolButton>

        <ToolButton
          label="Minimize"
          onClick={() => window.windowControls?.minimize?.()}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4">
            <path d="M5 12h14" stroke="currentColor" strokeWidth="2" />
          </svg>
        </ToolButton>

        <ToolButton
          danger
          label="Close"
          onClick={() => window.windowControls?.close?.()}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
        </ToolButton>
      </div>
    </div>
  );
}

function ToolButton({
  children,
  onClick,
  label,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={
        "h-10 w-12 grid place-items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
        (danger ? "hover:bg-red-500/80 hover:text-void" : "hover:bg-line")
      }
    >
      {children}
    </button>
  );
}
