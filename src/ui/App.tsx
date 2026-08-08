// src/ui/App.tsx
import { useEffect, useRef, useState } from "react";
import TitleBar from "./components/TitleBar";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import StatusLine from "./components/StatusLine";
import SettingsModal from "./components/SettingsModal";
import ErrorBoundary from "./components/ErrorBoundary";
import BackendStatusBanner from "./components/BackendStatusBanner";
import OllamaOnboardingGate from "./components/OllamaOnboardingGate";
import { useSessions } from "./hooks/useSessions";
import { useBackendHealth } from "./hooks/useBackendHealth";

function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { sessions, error: sessionsError, reload: reloadSessions } = useSessions(true, false);
  const health = useBackendHealth(true);
  const wasBackendUpRef = useRef(false);
  useEffect(() => {
    if (health?.backend && !wasBackendUpRef.current) {
      reloadSessions();
    }
    wasBackendUpRef.current = health?.backend ?? false;
  }, [health?.backend, reloadSessions]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="h-full flex items-center justify-center">
      <div className="h-[450px] w-[800px] rounded-sm border border-line bg-void overflow-hidden flex flex-col">
        <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
        <main className="flex-1 min-h-0 overflow-hidden [-webkit-app-region:no-drag] relative flex flex-col">
          <BackendStatusBanner />

          <div className="flex-1 min-h-0 flex flex-row relative">
            <ErrorBoundary>
              <Sidebar
                active
                collapsed={sidebarCollapsed}
                sessions={sessions}
                sessionsError={sessionsError}
                reloadSessions={reloadSessions}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </ErrorBoundary>
            <ErrorBoundary>
              <Chat sessions={sessions} sessionsError={sessionsError} selectedId={selectedId} />
            </ErrorBoundary>
            <button
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={`${sidebarCollapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`}
              className={
                "absolute top-1/2 -translate-y-1/2 z-20 h-8 w-5 grid place-items-center rounded-sm border border-line bg-panel text-dim hover:text-phosphor transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal [-webkit-app-region:no-drag] " +
                (sidebarCollapsed ? "left-0" : "left-56")
              }
            >
              {sidebarCollapsed ? "›" : "‹"}
            </button>
          </div>

          <StatusLine active />
          <OllamaOnboardingGate active />

          {settingsOpen && <SettingsModal active onClose={() => setSettingsOpen(false)} />}
        </main>
      </div>
    </div>
  );
}

export default App;
