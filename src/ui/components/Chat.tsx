import React, { useEffect, useRef, useState } from "react";
import { streamChatReply, type Session, type ChatTurn } from "../api";
import Welcome from "./Welcome";

interface Props {
  sessions: Session[] | null;
  sessionsError: string | null;
  selectedId: string | null;
}

const Chat: React.FC<Props> = ({ sessions, sessionsError, selectedId }) => {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    abortRef.current?.abort();
    setTurns([]);
    setError(null);
  }, [selectedId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleSend = async () => {
    const message = input.trim();
    if (!message || !selectedId || isStreaming) return;

    const history = turns;
    setTurns((prev) => [
      ...prev,
      { role: "user", content: message },
      { role: "assistant", content: "" },
    ]);
    setInput("");
    setError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const chunk of streamChatReply(selectedId, message, history, controller.signal)) {
        setTurns((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: next[next.length - 1].content + chunk,
          };
          return next;
        });
      }
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasMeetings = sessions !== null && sessions.length > 0;

  return (
    <div className="flex-1 min-w-0 h-full p-4 flex flex-col text-phosphor [-webkit-app-region:no-drag]">
      {sessions === null && sessionsError != null && (
        <div className="flex-1 flex items-center justify-center text-xs text-red-400 text-center px-4">
          couldn't load meetings: {sessionsError}
        </div>
      )}

      {sessions === null && sessionsError == null && (
        <div className="flex-1 flex items-center justify-center text-xs text-dim">
          loading<span className="cursor-blink">▌</span>
        </div>
      )}

      {sessions !== null && (!hasMeetings || !selected) && <Welcome sessions={sessions} />}

      {hasMeetings && selected && (
        <>
          <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 mb-2 text-xs">
            {turns.length === 0 && (
              <div className="border border-line rounded-sm px-3 py-2 text-dim max-w-md">
                <p className="text-signal">✦ {selected.title}</p>
                <p>ask anything about this meeting's recording</p>
              </div>
            )}
            {turns.map((t, i) => (
              <p
                key={i}
                className={"whitespace-pre-wrap " + (t.role === "user" ? "text-phosphor" : "text-dim")}
              >
                {t.role === "user" ? "> " : ""}
                {t.content}
                {t.role === "assistant" && i === turns.length - 1 && isStreaming && (
                  <span className="cursor-blink">▌</span>
                )}
              </p>
            ))}
            {error && <p className="text-red-400">error: {error}</p>}
          </div>

          <div className="border-t border-line px-4 py-2 -mx-4 -mb-4 flex items-center gap-2 text-xs [-webkit-app-region:no-drag]">
            <span className="text-signal shrink-0">&gt;</span>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="ask about this meeting... (enter to send)"
              aria-label="Chat message"
              className="flex-1 bg-transparent border-none outline-none text-phosphor placeholder:text-dim"
            />
            {isStreaming && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-signal cursor-blink shrink-0" aria-hidden="true" />
                <button
                  onClick={handleStop}
                  aria-label="Stop response"
                  className="h-6 w-6 grid place-items-center rounded-sm bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal shrink-0"
                >
                  <span className="h-2 w-2 bg-void" />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default Chat;
