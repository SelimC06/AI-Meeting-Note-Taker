import React, { useEffect, useRef, useState } from "react";
import { streamGraphChatReply, type ChatTurn, type GraphSource, type Session } from "../api";

interface Props {
  sessions: Session[];
  onSelectSession: (id: string) => void;
}

// A chat turn plus the retrieval sources the backend cited for it --
// sources are a UI-side annotation, never sent back as history.
type GraphTurn = ChatTurn & { sources?: GraphSource[] };

// Same threshold/meaning as Chat.tsx's constant.
const NEAR_BOTTOM_THRESHOLD_PX = 24;

const AllMeetingsChat: React.FC<Props> = ({ sessions, onSelectSession }) => {
  const [turns, setTurns] = useState<GraphTurn[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const isFollowingRef = useRef(true);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isFollowingRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
  };

  useEffect(() => {
    if (!isFollowingRef.current) return;
    bottomSentinelRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const handleSend = async () => {
    const message = input.trim();
    if (!message || isStreaming) return;

    const history: ChatTurn[] = turns.map(({ role, content }) => ({ role, content }));
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
      for await (const event of streamGraphChatReply(message, history, controller.signal)) {
        setTurns((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          if (event.type === "sources") {
            next[next.length - 1] = { ...last, sources: event.sources };
          } else {
            next[next.length - 1] = { ...last, content: last.content + event.token };
          }
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

  return (
    <>
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto flex flex-col gap-1.5 mb-2 text-xs"
      >
        {turns.length === 0 && (
          <div className="border border-line rounded-sm px-3 py-2 text-dim max-w-md">
            <p className="text-signal">✦ all meetings</p>
            <p>
              ask anything across your {sessions.length} recorded meeting{sessions.length === 1 ? "" : "s"}
            </p>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i}>
            <p className={"whitespace-pre-wrap " + (t.role === "user" ? "text-phosphor" : "text-dim")}>
              {t.role === "user" ? "> " : ""}
              {t.content}
              {t.role === "assistant" && i === turns.length - 1 && isStreaming && (
                <span className="cursor-blink">▌</span>
              )}
            </p>
            {t.role === "assistant" && t.sources && t.sources.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {t.sources.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onSelectSession(s.id)}
                    className="border border-line rounded-sm px-1.5 py-0.5 text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  >
                    {s.title} · {s.created_at.slice(0, 10)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {error && <p className="text-red-400">error: {error}</p>}
        <div ref={bottomSentinelRef} />
      </div>

      <div className="border-t border-line px-4 py-2 -mx-4 -mb-4 flex items-center gap-2 text-xs [-webkit-app-region:no-drag]">
        <span className="text-signal shrink-0">&gt;</span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="ask across all your meetings... (enter to send)"
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
  );
};

export default AllMeetingsChat;
