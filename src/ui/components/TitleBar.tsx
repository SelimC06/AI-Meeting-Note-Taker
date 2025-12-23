import { useState, useEffect } from "react";
import type { MainPage } from "../App";

declare global {
  interface Window {
    windowControls?: {
      minimize: () => void;
      close: () => void;
      toggleRail: () => Promise<boolean>;
      getRailState: () => Promise<boolean>;
    };
  }
}

interface Props {
  onChangePage: (page: MainPage) => void;
}

export default function TitleBar({ onChangePage }: Props) {
  return (
    <div
      className="h-10 flex items-center justify-between bg-neutral-800/70 text-neutral-200 select-none [-webkit-app-region:drag]"
    >
      {/* Drag region on the left */}
      <div className="flex items-center gap-2 px-3 text-xs opacity-80 [-webkit-app-region:no-drag] cursor-pointer"
        onClick={() => onChangePage("dashboard")}>
        {/* optional app icon / name */}
        <div className="w-2 h-2 rounded-full bg-emerald-400/80"></div>
        <span className="font-bold">Meeting Note Taker</span>
      </div>


      <div className="flex items-center gap-1 pr-1 [-webkit-app-region:no-drag]">
        <PillButton />

      {/* Window controls (must be no-drag) */}
      <ToolButton
        label="Minimize"
        onClick={() => window.windowControls?.minimize?.()}
      >
        {/* minus icon */}
        <svg viewBox="0 0 24 24" className="h-4 w-4">
          <path d="M5 12h14" stroke="currentColor" strokeWidth="2" />
        </svg>
      </ToolButton>

      <ToolButton
        danger
        label="Close"
        onClick={() => window.windowControls?.close?.()}
      >
        {/* close icon */}
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
        "h-10 w-12 grid place-items-center hover:bg-white/10 focus:outline-none" +
        (danger ? "hover:bg-red-500/80 hover:text-white" : "")
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
        console.log("[init] getRailState() →", v);
        if (!cancelled && typeof v === "boolean"){
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
    try{
      console.log("[click] before toggleRail, on =", on);
      const toggled = await window.windowControls?.toggleRail?.();

      if (typeof toggled === "boolean"){
        setOn(toggled);
      } else {
        const v = await window.windowControls?.getRailState?.();
        console.log("[click] fallback getRailState() →", v);
        if (typeof v === "boolean") {
          setOn(v);
        } else {
          setOn(prev => !prev);
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
      className={`
        inline-flex items-center justify-center
        h-5 w-16
        rounded-full
        text-xs font-semibold
        shadow
        focus:outline-none focus:ring-2 focus:ring-white/20
        [-webkit-app-region:no-drag]
        ${on
          ? "bg-blue-600 text-white hover:bg-blue-500"
          : "bg-neutral-600 text-white hover:bg-neutral-500"}
      `}
    >
      {on ? "Stop" : "Start"}
    </button>
  );
}
