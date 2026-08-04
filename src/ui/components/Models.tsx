import React, { useEffect, useState } from "react";
import { getSettings, type Settings } from "../api";

interface Props {
  active: boolean;
}

const Models: React.FC<Props> = ({ active }) => {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getSettings()
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return (
    <div className="p-4 w-50 h-[240px] bg-panel border border-line rounded-sm text-phosphor flex flex-col transition-all duration-150 hover:-translate-y-0.5 hover:border-signal hover:shadow-[0_0_16px_-4px_var(--color-signal)]">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[MODELS]</h2>
      <div className="text-xs space-y-4">
        <div>
          <p className="text-dim uppercase tracking-wide">whisper</p>
          <p className="text-phosphor truncate">{settings?.whisper_model ?? "--"}</p>
        </div>
        <div>
          <p className="text-dim uppercase tracking-wide">chat (ollama)</p>
          <p className="text-phosphor truncate">{settings?.ollama_chat_model ?? "--"}</p>
        </div>
      </div>
    </div>
  );
};

export default Models;
