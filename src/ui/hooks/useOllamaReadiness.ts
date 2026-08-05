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
    check();
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
