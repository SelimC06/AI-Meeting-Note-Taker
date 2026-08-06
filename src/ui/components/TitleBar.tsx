import { useState, useEffect } from "react";
import type { MainPage } from "../App";

interface Props {
  page: MainPage;
  onChangePage: (page: MainPage) => void;
}

const NAV_ITEMS: { key: MainPage; label: string }[] = [
  { key: "dashboard", label: "dashboard" },
  { key: "activity", label: "activity" },
  { key: "health", label: "health" },
  { key: "settings", label: "settings" },
];

export default function TitleBar({ page, onChangePage }: Props) {
  return (
    <div className="h-10 flex items-center justify-between bg-panel border-b border-line text-phosphor select-none [-webkit-app-region:drag] text-xs">
      <div className="flex items-center gap-3 px-3 [-webkit-app-region:no-drag]">
        <span className="font-semibold">
          $ meeting-note-taker<span className="cursor-blink">▌</span>
        </span>
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => onChangePage(item.key)}
              className={
                "px-1.5 py-0.5 rounded-sm transition focus:outline-none focus:ring-2 focus:ring-signal " +
                (page === item.key
                  ? "bg-signal text-void"
                  : "text-dim hover:text-phosphor")
              }
            >
              [{item.label}]
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-1 pr-1 [-webkit-app-region:no-drag]">
        <PillButton />

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
        "h-10 w-12 grid place-items-center focus:outline-none focus:ring-2 focus:ring-signal " +
        (danger ? "hover:bg-red-500/80 hover:text-void" : "hover:bg-line")
      }
    >
      {children}
    </button>
  );
}

function PillButton() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const v = await window.windowControls?.getRailState?.();
        if (!cancelled && typeof v === "boolean") {
          setOn(v);
        }
      } catch (e) {
        console.warn("[PillButton] getRailState (init) failed:", e);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const toggled = await window.windowControls?.toggleRail?.();

      if (typeof toggled === "boolean") {
        setOn(toggled);
      } else {
        const v = await window.windowControls?.getRailState?.();
        if (typeof v === "boolean") {
          setOn(v);
        } else {
          setOn((prev) => !prev);
        }
      }
    } catch (e) {
      console.error("[PillButton] toggle/getRailState failed:", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={
        "inline-flex items-center justify-center h-5 w-16 rounded-sm text-xs font-semibold " +
        "focus:outline-none focus:ring-2 focus:ring-signal [-webkit-app-region:no-drag] " +
        (on
          ? "bg-signal text-void"
          : "border border-line text-dim hover:text-phosphor")
      }
    >
      {on ? "Stop" : "Start"}
    </button>
  );
}
