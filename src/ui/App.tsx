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
  const [sidebarView, setSidebarView] = useState<"active" | "trash">("active");
  const { sessions, error: sessionsError, reload: reloadSessions } = useSessions(true, false);
  const health = useBackendHealth(true);
  const wasBackendUpRef = useRef(false);
  useEffect(() => {
    if (health?.backend && !wasBackendUpRef.current) {
      reloadSessions();
    }
    wasBackendUpRef.current = health?.backend ?? false;
  }, [health?.backend, reloadSessions]);

  // Mirrors the same rail-status subscription DockedRail.tsx uses, so the
  // sidebar-collapse toggle can be gated below: the sidebar is the only
  // place the docked rail's recording controls live, so collapsing it while
  // recording is active would strand the user with no way to stop/pause.
  const [railStatus, setRailStatus] = useState<RailPlaybackStatus>("idle");
  useEffect(() => {
    const unsubscribe = window.windowControls?.onRailStatus?.((s) => setRailStatus(s.status));
    return unsubscribe;
  }, []);

  // Also mirrors DockedRail.tsx's floating subscription: once the rail is
  // floating, the docked slot shows only a "[reattach rail]" button — full
  // record/pause controls live in the floating window instead — so
  // collapsing the sidebar can no longer strand anything, regardless of
  // recording status.
  const [isRailFloating, setIsRailFloating] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.windowControls?.getRailFloating?.()?.then((floating) => {
      if (!cancelled) setIsRailFloating(!!floating);
    });
    const unsubscribe = window.windowControls?.onRailFloating?.((floating) => setIsRailFloating(floating));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const railNeedsSidebar =
    (railStatus === "starting" || railStatus === "recording" || railStatus === "paused") && !isRailFloating;

  // If a recording starts right as the sidebar is collapsed, force it back
  // open rather than leaving the controls stranded.
  useEffect(() => {
    if (railNeedsSidebar) setSidebarCollapsed(false);
  }, [railNeedsSidebar]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (railNeedsSidebar) return;
        setSidebarCollapsed((c) => !c);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [railNeedsSidebar]);

  // On launch, main.js calls mainWindow.focus() once the window is ready to
  // show (see 'ready-to-show' in main.js) — well after this component has
  // already mounted. That's a real OS-level window-focus event, and since
  // nothing has been clicked/tabbed to yet, Chromium's :focus-visible
  // heuristic defaults to "visible" on whatever the first focusable element
  // in the page happens to be (the title bar's Settings button), showing a
  // focus ring nobody asked for. Blurring it on that first window-focus
  // event clears the unwanted ring without touching focus-visible for any
  // later, genuinely keyboard-driven focus (e.g. Alt-tabbing back into the
  // app mid-session shouldn't strip focus from whatever the user was doing).
  useEffect(() => {
    const clearAutoFocusOnce = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
      window.removeEventListener("focus", clearAutoFocusOnce);
    };
    window.addEventListener("focus", clearAutoFocusOnce);
    return () => window.removeEventListener("focus", clearAutoFocusOnce);
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
                view={sidebarView}
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
              onClick={() => {
                if (railNeedsSidebar) return;
                setSidebarCollapsed((c) => !c);
              }}
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

          <StatusLine
            active
            showViewToggle={!sidebarCollapsed}
            view={sidebarView}
            onViewChange={setSidebarView}
          />
          <OllamaOnboardingGate active />

          {settingsOpen && <SettingsModal active onClose={() => setSettingsOpen(false)} />}
        </main>
      </div>
    </div>
  );
}

export default App;
