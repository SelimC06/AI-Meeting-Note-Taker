import React from "react";
import { useSystemStats } from "../hooks/useSystemStats";

const Health: React.FC = () => {
  const stats = useSystemStats();

  return (
    <div className="p-4 w-50 h-full bg-panel border border-line rounded-sm text-phosphor transition-all duration-150 hover:-translate-y-0.5 hover:border-signal hover:shadow-[0_0_16px_-4px_var(--color-signal)]">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[HEALTH]</h2>
      <div className="text-xs text-dim space-y-1">
        <p>cpu usage: {stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "--"}</p>
        <p>ram usage: {stats?.memPercent != null ? `${stats.memPercent}%` : "--"}</p>
      </div>
    </div>
  );
};

export default Health;
