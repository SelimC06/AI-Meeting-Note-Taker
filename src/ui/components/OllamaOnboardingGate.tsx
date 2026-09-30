import { useEffect, useRef, useState, type ReactNode } from "react";
import { useOllamaReadiness } from "../hooks/useOllamaReadiness";
import { useDialog } from "../hooks/useDialog";

const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

type OllamaOnboardingGateProps = {
  active?: boolean;
  // True while another dialog (Settings, the consent notice) is open. The
  // gate sits below Settings (z-40 vs z-50) but, mounting later, would end
  // up on top of the dialog focus stack: focus jumped into its hidden link,
  // Escape stopped closing Settings, and Tab was trapped in the invisible
  // gate. It simply waits and appears once the other dialog closes.
  suppressed?: boolean;
};

// The gate's modal frame, split out so useDialog only runs while the gate
// is actually shown (the gate itself returns early otherwise). No Escape:
// it's answered with "Check again" or "Continue anyway", same as clicking.
function GateDialog({ children }: { children: (titleId: string) => ReactNode }) {
  const { dialogProps, titleId } = useDialog();
  return (
    <div className="absolute inset-0 z-40 bg-void flex items-center justify-center px-8">
      <div {...dialogProps} className="max-w-md flex flex-col items-center gap-3 text-center focus:outline-none">
        {children(titleId)}
      </div>
    </div>
  );
}

export default function OllamaOnboardingGate({ active = true, suppressed = false }: OllamaOnboardingGateProps) {
  const readiness = useOllamaReadiness(active);
  const [dismissed, setDismissed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  if (dismissed || suppressed) return null;
  if (readiness.status === "checking" || readiness.status === "ready") return null;

  const handleCopy = async (command: string) => {
    if (copyTimeoutRef.current !== null) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyTimeoutRef.current = setTimeout(() => {
      setCopyState("idle");
      copyTimeoutRef.current = null;
    }, 2000);
  };

  return (
    <GateDialog>
      {(titleId) => (
        <>
          <h2 id={titleId} className="text-sm font-semibold tracking-wide uppercase text-phosphor">
            [SETUP REQUIRED]
          </h2>

          {readiness.status === "unreachable" && (
            <>
              <p className="text-xs text-dim">
                This app uses <span className="text-phosphor">Ollama</span> to run its chat and
                summarization features locally. Ollama isn't reachable right now.
              </p>
              <a
                href={OLLAMA_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-signal underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                Download Ollama
              </a>
            </>
          )}

          {readiness.status === "model-missing" && (
            <>
              <p className="text-xs text-dim">
                Ollama is running, but the configured model{" "}
                <span className="text-phosphor">{readiness.model}</span> isn't pulled yet.
              </p>
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center justify-center gap-2">
                  <code className="text-xs bg-panel border border-line rounded-sm px-2 py-1 text-phosphor select-all">
                    ollama pull {readiness.model}
                  </code>
                  <button
                    onClick={() => handleCopy(`ollama pull ${readiness.model}`)}
                    className="px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  >
                    {copyState === "copied" ? "Copied" : "Copy"}
                  </button>
                </div>
                {copyState === "failed" && (
                  <p className="text-xs text-dim">Copy failed — select above</p>
                )}
              </div>
            </>
          )}

          <div className="flex items-center justify-center gap-3 mt-1">
            <button
              onClick={readiness.recheck}
              disabled={readiness.isRechecking}
              className="px-2 py-1 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {readiness.isRechecking ? "Checking…" : "Check again"}
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="text-xs text-dim underline hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              Continue anyway
            </button>
          </div>
        </>
      )}
    </GateDialog>
  );
}
