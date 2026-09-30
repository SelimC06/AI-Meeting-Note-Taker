import React, { useEffect, useState } from "react";
import { checkHealth, getSettings, type Settings } from "../api";
import { useSystemStats } from "../hooks/useSystemStats";

const POLL_INTERVAL_MS = 15000;

type SidebarView = "active" | "trash";

interface Props {
  active: boolean;
  // The active/trash buttons only make sense while the sidebar (which they
  // control) is actually visible — collapsing it hides them along with it.
  showViewToggle: boolean;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
}

const StatusLine: React.FC<Props> = ({ active, showViewToggle, view, onViewChange }) => {
  const stats = useSystemStats(active);
  const [online, setOnline] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    // Single-flight: skip a tick while the previous round is still out
    // (checkHealth carries its own deadline) instead of piling requests up
    // against a slow backend.
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      const health = checkHealth().then((ok) => {
        if (!cancelled) setOnline(ok);
      });
      const settingsRequest = getSettings()
        .then((s) => {
          if (!cancelled) setSettings(s);
        })
        .catch(() => {
          if (!cancelled) setSettings(null);
        });
      Promise.allSettled([health, settingsRequest]).then(() => {
        inFlight = false;
      });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  const viewButtonClass = (isSelected: boolean) =>
    "px-1.5 py-0.5 rounded-sm text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
    (isSelected ? "bg-signal text-void" : "text-dim hover:text-phosphor");

  return (
    <div className="h-6 shrink-0 flex items-center gap-2 px-3 border-t border-line bg-panel text-xs text-dim [-webkit-app-region:no-drag]">
      {showViewToggle && (
        // Sidebar is a fixed w-56 (224px) column starting flush against the
        // window's true left edge. -ml-3 cancels this bar's own px-3 left
        // padding just for this element, so it spans that identical 224px
        // (0 to w-56) rather than being inset by 12px — otherwise the
        // buttons below would center 6px off from the sidebar's real
        // midpoint. The divider (pinned to the right edge) then lands
        // exactly under the sidebar's own border-r either way.
        <div className="relative -ml-3 w-56 shrink-0 h-full flex items-center justify-center gap-3">
          <button className={viewButtonClass(view === "active")} onClick={() => onViewChange("active")}>
            [active]
          </button>
          <button className={viewButtonClass(view === "trash")} onClick={() => onViewChange("trash")}>
            [trash]
          </button>
          <span
            className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-line"
            aria-hidden="true"
          />
        </div>
      )}
      <span className="flex items-center gap-1 shrink-0">
        <span className={online ? "text-signal" : "text-dim"}>●</span>
        <span className={online === null ? "text-dim" : "text-phosphor"}>
          {online === null ? "checking..." : online ? "running" : "stopped"}
        </span>
      </span>
      <span className="shrink-0">
        cpu <span className="text-phosphor">{stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "--"}</span>
      </span>
      <span className="shrink-0 text-dim">·</span>
      <span className="shrink-0">
        mem <span className="text-phosphor">{stats?.memPercent != null ? `${stats.memPercent}%` : "--"}</span>
      </span>
      <span className="shrink-0 text-dim">·</span>
      <span className="truncate text-phosphor">
        {settings?.whisper_model ?? "--"} / {settings?.ollama_chat_model ?? "--"}
      </span>
    </div>
  );
};

export default StatusLine;
