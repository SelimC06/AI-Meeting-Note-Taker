import { useCallback, useRef, useState } from "react";
import { streamChatReply, type ChatTurn } from "../api";

export type ChatSessionState = {
  turns: ChatTurn[];
  isStreaming: boolean;
  error: string | null;
};

const EMPTY_SESSION_STATE: ChatSessionState = { turns: [], isStreaming: false, error: null };

// Owns every meeting's chat conversation, keyed by session id, in one
// place ABOVE Chat.tsx -- so a session's turns/isStreaming/error and its
// in-flight AbortController survive Chat re-rendering with a different
// selectedId (switching which meeting is displayed no longer aborts or
// resets anything). See
// docs/superpowers/specs/2026-08-13-persistent-per-session-chat-design.md.
export function useChatSessions() {
  const [sessionsById, setSessionsById] = useState<Record<string, ChatSessionState>>({});
  // One AbortController per session with an in-flight request. Not part of
  // React state -- aborting must never wait on a render.
  const controllersRef = useRef<Record<string, AbortController>>({});
  // Session ids discarded (permanently deleted) while their sendMessage was
  // still in flight -- lets that call's finally block skip re-inserting an
  // empty entry for a session that's supposed to be gone (discardSession
  // itself already removed it from sessionsById).
  const discardedRef = useRef<Set<string>>(new Set());

  const getState = useCallback(
    (sessionId: string): ChatSessionState => sessionsById[sessionId] ?? EMPTY_SESSION_STATE,
    [sessionsById]
  );

  const updateState = useCallback((sessionId: string, patch: Partial<ChatSessionState>) => {
    setSessionsById((prev) => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? EMPTY_SESSION_STATE), ...patch },
    }));
  }, []);

  // Runs to completion regardless of what's selected/displayed when it
  // finishes -- the only things that stop it are the session's own
  // AbortController (stopSession) or the stream ending naturally.
  const sendMessage = useCallback(
    async (sessionId: string, message: string) => {
      const current = getState(sessionId);
      if (!message.trim() || current.isStreaming) return;

      const history = current.turns;
      updateState(sessionId, {
        turns: [...history, { role: "user", content: message }, { role: "assistant", content: "" }],
        error: null,
        isStreaming: true,
      });

      const controller = new AbortController();
      controllersRef.current[sessionId] = controller;

      try {
        for await (const chunk of streamChatReply(sessionId, message, history, controller.signal)) {
          setSessionsById((prev) => {
            const existing = prev[sessionId] ?? EMPTY_SESSION_STATE;
            const turns = existing.turns;
            if (turns.length === 0) return prev;
            const next = [...turns];
            next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + chunk };
            return { ...prev, [sessionId]: { ...existing, turns: next } };
          });
        }
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") {
          updateState(sessionId, { error: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        delete controllersRef.current[sessionId];
        if (discardedRef.current.has(sessionId)) {
          discardedRef.current.delete(sessionId);
        } else {
          updateState(sessionId, { isStreaming: false });
        }
      }
    },
    [getState, updateState]
  );

  const stopSession = useCallback((sessionId: string) => {
    controllersRef.current[sessionId]?.abort();
  }, []);

  // Called when a session is permanently deleted -- aborts anything in
  // flight and drops its state so a dead session id never lingers in
  // memory or as a stale Stop-button target. NOT called for trash (which
  // is reversible): a trashed-then-restored meeting's conversation should
  // survive the round trip, same as its notes do.
  const discardSession = useCallback((sessionId: string) => {
    if (controllersRef.current[sessionId]) discardedRef.current.add(sessionId);
    controllersRef.current[sessionId]?.abort();
    delete controllersRef.current[sessionId];
    setSessionsById((prev) => {
      if (!(sessionId in prev)) return prev;
      const rest = { ...prev };
      delete rest[sessionId];
      return rest;
    });
  }, []);

  return { getState, sendMessage, stopSession, discardSession };
}
