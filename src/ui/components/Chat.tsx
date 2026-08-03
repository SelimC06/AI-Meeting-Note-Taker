import React, { useEffect, useRef, useState } from "react";
import { getSessions, streamChatReply, type Session, type ChatTurn } from "../api";

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

interface Props {
  active: boolean;
}

const Chat: React.FC<Props> = ({ active }) => {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pickerDropdownRef = useRef<HTMLDivElement | null>(null);
  const pickerToggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getSessions()
      .then((data) => {
        if (cancelled) return;
        setSessions(data);
        // Only auto-pick a meeting the first time (don't yank the
        // selection out from under an ongoing conversation on refetch).
        setSelectedId((prev) => prev ?? data[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    if (!pickerOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInsideDropdown = pickerDropdownRef.current?.contains(target) ?? false;
      const clickedToggle = pickerToggleRef.current?.contains(target) ?? false;
      if (!clickedInsideDropdown && !clickedToggle) {
        setPickerOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPickerOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [pickerOpen]);

  const selectMeeting = (id: string) => {
    abortRef.current?.abort();
    setSelectedId(id);
    setTurns([]);
    setError(null);
    setPickerOpen(false);
  };

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
    <div className="p-4 w-[50%] h-[240px] bg-panel border border-line rounded-sm text-phosphor flex flex-col [-webkit-app-region:no-drag]">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[CHAT]</h2>

      {sessions === null && (
        <div className="flex-1 flex items-center justify-center text-xs text-dim">
          loading<span className="cursor-blink">▌</span>
        </div>
      )}

      {sessions !== null && !hasMeetings && (
        <div className="flex-1 flex items-center justify-center text-xs text-dim text-center px-4">
          record a meeting first
        </div>
      )}

      {hasMeetings && (
        <>
          <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 mb-2 text-xs">
            {turns.length === 0 && (
              <p className="text-dim">ask about "{selected?.title}"</p>
            )}
            {turns.map((t, i) => (
              <p
                key={i}
                className={
                  "whitespace-pre-wrap " + (t.role === "user" ? "text-phosphor" : "text-dim")
                }
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

          <div className="relative">
            {pickerOpen && (
              <div
                ref={pickerDropdownRef}
                className="absolute bottom-full mb-1 left-0 right-0 max-h-32 overflow-y-auto bg-panel border border-line rounded-sm z-10"
              >
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => selectMeeting(s.id)}
                    className="w-full text-left px-2 py-1 text-xs hover:bg-signal hover:text-void transition"
                  >
                    {s.title}
                    <span className="text-dim ml-1">{formatRelativeTime(s.created_at)}</span>
                  </button>
                ))}
              </div>
            )}

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="ask about this meeting..."
              aria-label="Chat message"
              className="block w-full p-2 text-phosphor border border-line rounded-sm bg-void text-xs placeholder:text-dim mb-1.5 focus:outline-none focus:ring-2 focus:ring-signal"
            />

            <div className="flex items-center justify-between text-xs">
              <button
                ref={pickerToggleRef}
                onClick={() => setPickerOpen((v) => !v)}
                className="px-1.5 py-0.5 rounded-sm border border-line text-dim hover:text-phosphor transition truncate max-w-[60%] focus:outline-none focus:ring-2 focus:ring-signal"
              >
                {selected?.title ?? "select meeting"}
              </button>

              <div className="flex items-center gap-2">
                {isStreaming && (
                  <span className="h-1.5 w-1.5 rounded-full bg-signal cursor-blink" aria-hidden="true" />
                )}
                {isStreaming ? (
                  <button
                    onClick={handleStop}
                    aria-label="Stop response"
                    className="h-6 w-6 grid place-items-center rounded-sm bg-red-500 focus:outline-none focus:ring-2 focus:ring-signal"
                  >
                    <span className="h-2 w-2 bg-void" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim()}
                    aria-label="Send"
                    className="px-2 py-0.5 rounded-sm bg-signal text-void disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-signal"
                  >
                    send
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default Chat;
