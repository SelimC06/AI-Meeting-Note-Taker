import React, { useEffect, useState } from "react";
import { checkHealth, getSettings, type Settings } from "../api";
import { useSystemStats } from "../hooks/useSystemStats";

const POLL_INTERVAL_MS = 15000;

interface Props {
  active: boolean;
}

const StatusLine: React.FC<Props> = ({ active }) => {
  const stats = useSystemStats(active);
  const [online, setOnline] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = () => {
      checkHealth().then((ok) => {
        if (!cancelled) setOnline(ok);
      });
      getSettings()
        .then((s) => {
          if (!cancelled) setSettings(s);
        })
        .catch(() => {
          if (!cancelled) setSettings(null);
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  return (
    <div className="h-6 shrink-0 flex items-center gap-2 px-3 border-t border-line bg-panel text-xs text-dim [-webkit-app-region:no-drag]">
      <span className="flex items-center gap-1 shrink-0">
        <span className={online ? "text-signal" : "text-dim"}>●</span>
        <span className={online === null ? "text-dim" : "text-phosphor"}>
          {online === null ? "checking..." : online ? "online" : "offline"}
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
