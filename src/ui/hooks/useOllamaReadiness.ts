import { useCallback, useEffect, useRef, useState } from "react";
import { getOllamaModels, getSettings } from "../api";

export type OllamaReadiness =
  | { status: "checking" }
  | { status: "unreachable" }
  | { status: "model-missing"; model: string }
  | { status: "ready" };

export function useOllamaReadiness(
  active = true
): OllamaReadiness & { recheck: () => void; isRechecking: boolean } {
  const [state, setState] = useState<OllamaReadiness>({ status: "checking" });
  const [isRechecking, setIsRechecking] = useState(false);
  const generationRef = useRef(0);
  const hasCheckedOnceRef = useRef(false);

  const check = useCallback(() => {
    const generation = ++generationRef.current;
    const isFirstCheck = !hasCheckedOnceRef.current;
    hasCheckedOnceRef.current = true;

    if (isFirstCheck) {
      setState({ status: "checking" });
    } else {
      setIsRechecking(true);
    }

    Promise.all([getOllamaModels(), getSettings()])
      .then(([modelsResult, settings]) => {
        if (generation !== generationRef.current) return;
        // Ollama is irrelevant with a custom (OpenAI-compatible) provider
        // selected -- chat, summaries and extraction all go there instead --
        // so there's nothing to set up. Checked before the Ollama result,
        // which is "unreachable" for exactly these users (no Ollama
        // installed), and used to put the full-screen setup gate in front
        // of them on every launch.
        if (settings.ai_provider === "custom") {
          setState({ status: "ready" });
          return;
        }
        if (!modelsResult.ok) {
          setState({ status: "unreachable" });
          return;
        }
        const model = settings.ollama_chat_model;
        if (!modelsResult.models.includes(model)) {
          setState({ status: "model-missing", model });
          return;
        }
        setState({ status: "ready" });
      })
      .catch(() => {
        if (generation !== generationRef.current) return;
        setState({ status: "unreachable" });
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        setIsRechecking(false);
      });
  }, []);

  useEffect(() => {
    // Skip the check while inactive (e.g. the backend hasn't reported
    // healthy yet) -- getOllamaModels maps a connection-refused fetch
    // (backend still booting) to the same {ok:false} shape as "Ollama
    // isn't installed", so checking too early misreads a normal cold start
    // as a setup problem. The activation effect below runs the first real
    // check once `active` actually flips true; state stays "checking"
    // (rendered as nothing by OllamaOnboardingGate) until then.
    if (active) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      check();
    }
    wasActiveRef.current = active;
  }, [active, check]);

  return { ...state, recheck: check, isRechecking };
}
