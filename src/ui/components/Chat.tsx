import React, { useEffect, useRef, useState } from "react";
import type { Session } from "../api";
import type { useChatSessions } from "../hooks/useChatSessions";
import Welcome from "./Welcome";
import AllMeetingsChat from "./AllMeetingsChat";

interface Props {
  sessions: Session[] | null;
  sessionsError: string | null;
  selectedId: string | null;
  // See Sidebar's identically-named prop -- same G9 fix, same reasoning:
  // suppresses the "couldn't load meetings" error during the brief window
  // before the backend lifecycle first reports healthy, showing the
  // neutral loading state instead. Defaults true for callers/tests that
  // don't care about the distinction.
  backendUp?: boolean;
  // True once the backend lifecycle (see useBackendLifecycle/App.tsx) has
  // reported 'failed' -- unlike backendUp (the 15s health poll), this can
  // only ever become true, so it's used to stop suppressing sessionsError
  // once the backend is known to never be coming back on its own, instead
  // of showing "loading" forever (re-review-12-13 H1/L1). Defaults false.
  backendFailed?: boolean;
  // Invoked when the user clicks a source chip in the all-meetings view --
  // same contract as Sidebar's onSelect. Optional so existing tests/callers
  // that never show the all-meetings view don't need it.
  onSelectSession?: (id: string) => void;
  // Owns every meeting's chat conversation state one level above Chat, so
  // it survives Chat re-rendering with a different selectedId instead of
  // being aborted and reset on every switch. See
  // docs/superpowers/specs/2026-08-13-persistent-per-session-chat-design.md.
  chatSessions: ReturnType<typeof useChatSessions>;
}

// How close to the bottom (in px) counts as "already there" for
// auto-scroll purposes -- a small allowance for sub-pixel/rounding scroll
// positions, not a real "almost at the bottom" zone.
const NEAR_BOTTOM_THRESHOLD_PX = 24;

const Chat: React.FC<Props> = ({
  sessions,
  sessionsError,
  selectedId,
  backendUp = true,
  backendFailed = false,
  onSelectSession,
  chatSessions,
}) => {
  const [input, setInput] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is currently pinned to the bottom of the scroll
  // container, updated only by real scroll events (see handleScroll below)
  // rather than re-measured after every DOM update -- a streamed chunk
  // growing scrollHeight never fires 'scroll' on its own, so this can't be
  // thrown off by the very content whose arrival it's deciding on (H2).
  const isFollowingRef = useRef(true);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;
  const { turns, isStreaming, error } = chatSessions.getState(selectedId ?? "");

  // Purely a per-view scroll-position default, NOT conversation state --
  // unlike turns/isStreaming/error (now owned by chatSessions and
  // deliberately NOT reset here), it's correct for this to reset on every
  // selection change.
  useEffect(() => {
    isFollowingRef.current = true;
  }, [selectedId]);

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isFollowingRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
  };

  // Auto-scrolls to the newest message/streamed chunk, but only when the
  // user was already following the bottom -- otherwise a long streamed
  // reply grows below the fold with no way to see it without manually
  // scrolling down on every chunk. Follows isFollowingRef (last real scroll
  // position, tracked by handleScroll) rather than re-measuring here, since
  // by the time this effect runs the chunk that triggered it is already in
  // the DOM and would otherwise count against itself.
  useEffect(() => {
    if (!isFollowingRef.current) return;
    bottomSentinelRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const handleSend = () => {
    const message = input.trim();
    if (!message || !selectedId || isStreaming) return;
    setInput("");
    void chatSessions.sendMessage(selectedId, message);
  };

  const handleStop = () => {
    if (!selectedId) return;
    chatSessions.stopSession(selectedId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasMeetings = sessions !== null && sessions.length > 0;

  return (
    <div className="flex-1 min-w-0 min-h-0 h-full p-4 flex flex-col text-phosphor [-webkit-app-region:no-drag]">
      {sessions === null && sessionsError != null && (backendUp || backendFailed) && (
        <div className="flex-1 flex items-center justify-center text-xs text-red-400 text-center px-4">
          couldn't load meetings: {sessionsError}
        </div>
      )}

      {sessions === null && (sessionsError == null || (!backendUp && !backendFailed)) && (
        <div className="flex-1 flex items-center justify-center text-xs text-dim">
          loading<span className="cursor-blink">▌</span>
        </div>
      )}

      {sessions !== null && !hasMeetings && <Welcome sessions={sessions} />}

      {hasMeetings && (
        // Kept mounted whenever there are meetings (not just while no
        // session is selected) and toggled via `display` instead of
        // conditional rendering: unmounting AllMeetingsChat on every source
        // chip click destroyed its `turns` state, wiping the cross-meeting
        // conversation each time the user checked a source. `display:
        // contents` makes this wrapper disappear from the box model when
        // visible, so it doesn't disrupt the flex column layout
        // AllMeetingsChat expects as a direct flex child of the container
        // above.
        <div style={{ display: selected ? "none" : "contents" }}>
          <AllMeetingsChat sessions={sessions} onSelectSession={onSelectSession ?? (() => {})} />
        </div>
      )}

      {hasMeetings && selected && (
        <>
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto flex flex-col gap-2 mb-2 text-[13px]"
          >
            {turns.length === 0 && (
              <div className="border border-line rounded-sm px-3 py-2 text-dim max-w-md">
                <p className="text-signal">✦ {selected.title}</p>
                <p>ask anything about this meeting's recording</p>
              </div>
            )}
            {turns.map((t, i) => (
              <p
                key={i}
                className={
                  "whitespace-pre-wrap max-w-3xl " +
                  (t.role === "user"
                    ? "text-phosphor"
                    : // Reading surface (UI refresh): model answers in the
                      // proportional reading face; prompts stay mono chrome.
                      "font-reading leading-relaxed text-dim")
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
            <div ref={bottomSentinelRef} />
          </div>

          <div className="border-t border-line px-4 py-2.5 -mx-4 -mb-4 flex items-center gap-2 text-[13px] [-webkit-app-region:no-drag]">
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
