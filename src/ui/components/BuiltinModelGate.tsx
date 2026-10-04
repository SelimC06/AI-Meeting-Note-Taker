import { useEffect, useRef, useState, type ReactNode } from "react";
import { getBuiltinStatus, getSettings, startBuiltinSetup, type BuiltinStatus } from "../api";
import { useDialog } from "../hooks/useDialog";

type BuiltinModelGateProps = {
  active?: boolean;
  // Same contract as OllamaOnboardingGate: wait while another dialog
  // (Settings, the consent notice) is open so this gate never lands on top
  // of that dialog's focus stack.
  suppressed?: boolean;
};

// The gate's modal frame (same shape as OllamaOnboardingGate's): useDialog
// only runs while the gate is actually shown. No Escape -- it's answered
// with one of the buttons.
function GateDialog({ children }: { children: (titleId: string) => ReactNode }) {
  const { dialogProps, titleId } = useDialog();
  return (
    <div className="absolute inset-0 z-40 bg-void flex items-center justify-center px-8">
      <div {...dialogProps} className="max-w-md w-full flex flex-col items-center gap-3 text-center focus:outline-none">
        {children(titleId)}
      </div>
    </div>
  );
}

function gigabytes(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

// First-run setup for the built-in AI provider: offers the one-time model
// download (never started silently -- it's ~2.5 GB), then renders download
// progress and the server boot until /builtin/status reports ready.
// Invisible whenever another provider is selected; the Ollama provider has
// its own gate (OllamaOnboardingGate).
export default function BuiltinModelGate({ active = true, suppressed = false }: BuiltinModelGateProps) {
  const [provider, setProvider] = useState<string | null>(null);
  const [status, setStatus] = useState<BuiltinStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [requesting, setRequesting] = useState(false);
  // Once the answer is final for this effect cycle (non-builtin provider,
  // or the server is ready), later ticks skip the network entirely. The
  // effect re-runs -- and re-checks -- when Settings closes (`suppressed`
  // flips) or the backend comes back (`active` flips), the only moments
  // the answer can change.
  const settledRef = useRef(false);

  useEffect(() => {
    if (!active || dismissed) return;
    settledRef.current = false;
    let cancelled = false;

    const tick = async () => {
      if (settledRef.current) return;
      const settings = await getSettings().catch(() => null);
      if (cancelled) return;
      const currentProvider = settings?.ai_provider ?? null;
      setProvider(currentProvider);
      if (currentProvider === null) return; // backend not answering yet
      if (currentProvider !== "builtin") {
        settledRef.current = true;
        return;
      }
      const next = await getBuiltinStatus();
      if (cancelled || next === null) return;
      setStatus(next);
      if (next.state === "ready") settledRef.current = true;
    };

    tick();
    const id = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, suppressed, dismissed]);

  if (dismissed || suppressed || !active) return null;
  if (provider !== "builtin") return null;
  if (status === null || status.state === "ready") return null;

  const handleSetup = async () => {
    setRequesting(true);
    try {
      const next = await startBuiltinSetup();
      if (next) setStatus(next);
    } finally {
      setRequesting(false);
    }
  };

  const continueAnyway = (
    <button
      onClick={() => setDismissed(true)}
      className="text-xs text-dim underline hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      Continue anyway
    </button>
  );

  const totalGb = gigabytes(status.model.size_bytes);

  return (
    <GateDialog>
      {(titleId) => (
        <>
          <h2 id={titleId} className="text-sm font-semibold tracking-wide uppercase text-phosphor">
            {status.state === "error" ? "[SETUP FAILED]" : "[SETUP]"}
          </h2>

          {status.state === "idle" && (
            <>
              <p className="text-xs text-dim">
                DeskRecap runs its AI notes and chat locally with a built-in model
                (<span className="text-phosphor">{status.model.label}</span>).
                {status.model_downloaded
                  ? " The model is already on this machine -- start it to finish setup."
                  : ` Download it once (${totalGb} GB) -- after that, nothing ever leaves this machine.`}
              </p>
              <button
                onClick={handleSetup}
                disabled={requesting}
                className="px-3 py-1.5 rounded-sm text-xs border border-line text-phosphor hover:bg-panel focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {requesting
                  ? "Starting…"
                  : status.model_downloaded
                    ? "Start model"
                    : `Download model (${totalGb} GB)`}
              </button>
              <p className="text-xs text-dim">
                Prefer your own setup? Pick Ollama or a custom API under Settings → AI model.
              </p>
              {continueAnyway}
            </>
          )}

          {status.state === "downloading" && (
            <>
              <p className="text-xs text-dim">
                Downloading <span className="text-phosphor">{status.model.label}</span>…
                You can keep using the app; recording works now, AI notes start
                once the model is ready.
              </p>
              {(() => {
                const downloaded = status.progress?.downloaded_bytes ?? 0;
                const total = status.progress?.total_bytes ?? status.model.size_bytes;
                const percent = total > 0 ? Math.min(100, Math.floor((downloaded * 100) / total)) : 0;
                return (
                  <div className="w-full flex flex-col items-center gap-1">
                    <div
                      role="progressbar"
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Model download"
                      className="w-full h-2 border border-line bg-panel"
                    >
                      <div className="h-full bg-phosphor" style={{ width: `${percent}%` }} />
                    </div>
                    <p className="text-xs text-dim tabular-nums">
                      {gigabytes(downloaded)} / {gigabytes(total)} GB · {percent}%
                    </p>
                  </div>
                );
              })()}
              {continueAnyway}
            </>
          )}

          {status.state === "verifying" && (
            <>
              <p className="text-xs text-dim">Verifying the downloaded model…</p>
              {continueAnyway}
            </>
          )}

          {status.state === "starting" && (
            <>
              <p className="text-xs text-dim">
                Starting the local model… This takes a moment the first time.
              </p>
              {continueAnyway}
            </>
          )}

          {status.state === "error" && (
            <>
              <p className="text-xs text-dim break-words">
                {status.error ?? "The built-in model couldn't be set up."}
              </p>
              <div className="flex items-center justify-center gap-3 mt-1">
                <button
                  onClick={handleSetup}
                  disabled={requesting}
                  className="px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {requesting ? "Retrying…" : "Try again"}
                </button>
                {continueAnyway}
              </div>
            </>
          )}
        </>
      )}
    </GateDialog>
  );
}
