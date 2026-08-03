# Terminal/Phosphor Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the whole frontend (main window + rail widget) a consistent terminal/phosphor visual identity, and fix the Chat default-form-submit bug and the fake Status toggle as part of the same pass.

**Architecture:** A single shared theme file (`src/theme.css`) defines six color tokens and a bundled monospace font via Tailwind v4's CSS-native `@theme` block, imported by both Vite entry stylesheets (`src/ui/index.css`, `src/rail/rail.css`). Every component then gets a targeted restyle to the new tokens — no logic changes except `Status.tsx` (real health polling) and `Chat.tsx` (form removed to eliminate the submit-bug class entirely).

**Tech Stack:** React 19/TypeScript/Vite frontend, Tailwind CSS v4 (CSS-native theming via `@theme`, no `tailwind.config.js`), `@fontsource/jetbrains-mono` for the self-hosted font.

## Global Constraints

- Color tokens (exact hex, from the spec): `--color-void: #0A0F0C`, `--color-panel: #10160E`, `--color-line: #1F2E1C`, `--color-phosphor: #B9F5C4`, `--color-dim: #5C7A5E`, `--color-signal: #39FF88`. Recording red stays the existing Tailwind `red-500`/`red-600` — not a new token.
- Typeface: JetBrains Mono only, self-hosted via `@fontsource/jetbrains-mono`, weights 400/500/600. No second (sans/serif) family introduced anywhere.
- Panels: sharp corners (`rounded-sm`, ~2px — not `rounded-xl`), `border-line` hairline borders, no drop shadows, no backdrop blur. Exception: HealthPage's circular load gauge stays `rounded-full` — it's a genuine circular data visualization, not a container panel.
- Signature interaction: interactive rows/tabs use inverse video on hover/active/selected — `bg-signal` background with `text-void`/`bg-void`-colored text — not a subtle color shift.
- Blinking cursor (`▌`) is CSS-animated, disabled under `prefers-reduced-motion: reduce`, and used sparingly (next to the app name, after empty-state text) — not decoratively elsewhere.
- Out of scope for every task below: Health page real system stats (stays hardcoded), recording feedback improvements (error surfacing/uploading state/timer), TitleBar rail-visibility pill relabeling, any new backend endpoints beyond reusing existing `GET /health`, login UI, video playback, resizable-layout overhaul, Chat backend, frontend test framework.

---

## Task 1: Theme foundation

**Files:**
- Modify: `package.json`
- Create: `src/theme.css`
- Modify: `src/ui/index.css`
- Modify: `src/rail/rail.css`

**Interfaces:**
- Produces: Tailwind utility classes `bg-void`, `text-void`, `bg-panel`, `border-line`, `text-phosphor`, `text-dim`, `bg-signal`, `text-signal`, `border-signal` (all generated automatically by Tailwind v4 from the `--color-*` theme variables), plus a hand-written `.cursor-blink` CSS class for the blinking-cursor animation. Every later task consumes these.

- [ ] **Step 1: Add the font package**

Run: `npm install @fontsource/jetbrains-mono`

- [ ] **Step 2: Create the shared theme file**

Create `src/theme.css`:

```css
@import "@fontsource/jetbrains-mono/400.css";
@import "@fontsource/jetbrains-mono/500.css";
@import "@fontsource/jetbrains-mono/600.css";

@theme {
  --color-void: #0A0F0C;
  --color-panel: #10160E;
  --color-line: #1F2E1C;
  --color-phosphor: #B9F5C4;
  --color-dim: #5C7A5E;
  --color-signal: #39FF88;
  --font-sans: "JetBrains Mono", ui-monospace, monospace;
}

@layer base {
  body {
    background-color: var(--color-void);
    color: var(--color-phosphor);
  }
}

@keyframes blink-cursor {
  0%, 49% {
    opacity: 1;
  }
  50%, 100% {
    opacity: 0;
  }
}

.cursor-blink {
  animation: blink-cursor 1s steps(1, end) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .cursor-blink {
    animation: none;
    opacity: 1;
  }
}
```

- [ ] **Step 3: Import the theme from both entry stylesheets**

Replace the full contents of `src/ui/index.css`:

```css
@import "tailwindcss";
@import "../theme.css";
```

Replace the full contents of `src/rail/rail.css`:

```css
@import "tailwindcss";
@import "../theme.css";
```

- [ ] **Step 4: Verify the build picks up the theme**

Run: `npx tsc -b --noEmit && npx vite build`
Expected: build succeeds with no errors.

Then check the theme variables and font actually landed in the output CSS:

Run (from repo root, PowerShell or Bash): search `dist-react/assets/*.css` for the strings `--color-void`, `--color-signal`, `.cursor-blink`, and `JetBrains Mono`. All four must be present. (Tailwind v4 always emits `@theme` variables as CSS custom properties regardless of whether any utility using them appears yet, so this check is valid even before any component uses the new colors.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/theme.css src/ui/index.css src/rail/rail.css
git commit -m "feat: add terminal/phosphor theme tokens and bundled JetBrains Mono font"
```

---

## Task 2: Real backend-health Status panel

**Files:**
- Modify: `src/ui/api.ts`
- Modify: `src/ui/components/Status.tsx` (full rewrite)

**Interfaces:**
- Consumes: `BACKEND_URL` (already exported from `src/ui/api.ts`); theme tokens from Task 1.
- Produces: `checkHealth(): Promise<boolean>` exported from `src/ui/api.ts`, usable by any future component that wants a live backend-health check.

- [ ] **Step 1: Add `checkHealth` to the API client**

In `src/ui/api.ts`, add this function after `getSessions`:

```typescript
export async function checkHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${BACKEND_URL}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Rewrite Status.tsx**

Replace the full contents of `src/ui/components/Status.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { checkHealth } from "../api";

const POLL_INTERVAL_MS = 15000;

const Status: React.FC = () => {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      checkHealth().then((ok) => {
        if (!cancelled) setOnline(ok);
      });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="p-4 w-100 bg-panel border border-line rounded-sm text-phosphor">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[STATUS]</h2>
      <div className="flex items-center gap-2 text-sm">
        <span className={online ? "text-signal" : "text-dim"}>
          {online ? "●" : "○"}
        </span>
        <span>
          backend: {online === null ? "checking..." : online ? "online" : "offline"}
        </span>
      </div>
    </div>
  );
};

export default Status;
```

This removes the old fake toggle switch entirely — `Status` no longer has any local on/off state disconnected from reality.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/api.ts src/ui/components/Status.tsx
git commit -m "feat: replace fake Status toggle with real GET /health polling"
```

---

## Task 3: Fix the Chat form-submit bug

**Files:**
- Modify: `src/ui/components/Chat.tsx` (full rewrite)

**Interfaces:**
- Consumes: theme tokens from Task 1.

- [ ] **Step 1: Rewrite Chat.tsx**

Replace the full contents of `src/ui/components/Chat.tsx`:

```tsx
import React from "react";

const Chat: React.FC = () => {
  return (
    <div className="p-4 w-[50%] h-[240px] bg-panel border border-line rounded-sm text-phosphor flex flex-col [-webkit-app-region:no-drag]">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[CHAT]</h2>
      <div className="mt-auto no-drag relative z-50 pointer-events-auto">
        <input
          type="text"
          value=""
          disabled
          readOnly
          placeholder="> ask about this meeting (coming soon)"
          className="block w-full p-2 text-dim border border-line rounded-sm bg-void text-xs placeholder:text-dim cursor-not-allowed"
        />
      </div>
    </div>
  );
};

export default Chat;
```

The `<form>` element is gone entirely — not just given a `preventDefault` handler. A disabled input inside a live `<form>` can still theoretically be submitted (e.g. an Enter keypress bubbling from a different focused element, or a future stray submit button); removing the `<form>` wrapper removes the whole bug class rather than papering over one trigger path.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/Chat.tsx
git commit -m "fix: remove Chat's default-submitting form, replace with disabled input"
```

---

## Task 4: TitleBar prompt-bar restyle with nav tabs

**Files:**
- Modify: `src/ui/components/TitleBar.tsx` (full rewrite)
- Modify: `src/ui/App.tsx:14` (pass current page to TitleBar)

**Interfaces:**
- Consumes: `MainPage` type from `src/ui/App.tsx` (unchanged: `"dashboard" | "activity" | "health"`); theme tokens from Task 1.
- Produces: `TitleBar` now requires a `page: MainPage` prop in addition to the existing `onChangePage`.

- [ ] **Step 1: Pass `page` into TitleBar from App.tsx**

In `src/ui/App.tsx`, find this line:

```tsx
        <TitleBar onChangePage={setPage}/>
```

Replace it with:

```tsx
        <TitleBar page={page} onChangePage={setPage}/>
```

- [ ] **Step 2: Rewrite TitleBar.tsx**

Replace the full contents of `src/ui/components/TitleBar.tsx`:

```tsx
import { useState, useEffect } from "react";
import type { MainPage } from "../App";

declare global {
  interface Window {
    windowControls?: {
      minimize: () => void;
      close: () => void;
      toggleRail: () => Promise<boolean>;
      getRailState: () => Promise<boolean>;
    };
  }
}

interface Props {
  page: MainPage;
  onChangePage: (page: MainPage) => void;
}

const NAV_ITEMS: { key: MainPage; label: string }[] = [
  { key: "dashboard", label: "dashboard" },
  { key: "activity", label: "activity" },
  { key: "health", label: "health" },
];

export default function TitleBar({ page, onChangePage }: Props) {
  return (
    <div className="h-10 flex items-center justify-between bg-panel border-b border-line text-phosphor select-none [-webkit-app-region:drag] text-xs">
      <div className="flex items-center gap-3 px-3 [-webkit-app-region:no-drag]">
        <span className="font-semibold">
          meeting-note-taker<span className="cursor-blink">▌</span>
        </span>
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => onChangePage(item.key)}
              className={
                "px-1.5 py-0.5 rounded-sm transition " +
                (page === item.key
                  ? "bg-signal text-void"
                  : "text-dim hover:text-phosphor")
              }
            >
              [{item.label}]
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-1 pr-1 [-webkit-app-region:no-drag]">
        <PillButton />

        <ToolButton
          label="Minimize"
          onClick={() => window.windowControls?.minimize?.()}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4">
            <path d="M5 12h14" stroke="currentColor" strokeWidth="2" />
          </svg>
        </ToolButton>

        <ToolButton
          danger
          label="Close"
          onClick={() => window.windowControls?.close?.()}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
        </ToolButton>
      </div>
    </div>
  );
}

function ToolButton({
  children,
  onClick,
  label,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={
        "h-10 w-12 grid place-items-center hover:bg-line focus:outline-none focus:ring-2 focus:ring-signal " +
        (danger ? "hover:bg-red-500/80 hover:text-void" : "")
      }
    >
      {children}
    </button>
  );
}

function PillButton() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const v = await window.windowControls?.getRailState?.();
        if (!cancelled && typeof v === "boolean") {
          setOn(v);
        }
      } catch (e) {
        console.warn("[PillButton] getRailState (init) failed:", e);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const toggled = await window.windowControls?.toggleRail?.();

      if (typeof toggled === "boolean") {
        setOn(toggled);
      } else {
        const v = await window.windowControls?.getRailState?.();
        if (typeof v === "boolean") {
          setOn(v);
        } else {
          setOn((prev) => !prev);
        }
      }
    } catch (e) {
      console.error("[PillButton] toggle/getRailState failed:", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={
        "inline-flex items-center justify-center h-5 w-16 rounded-sm text-xs font-semibold " +
        "focus:outline-none focus:ring-2 focus:ring-signal [-webkit-app-region:no-drag] " +
        (on
          ? "bg-signal text-void"
          : "border border-line text-dim hover:text-phosphor")
      }
    >
      {on ? "Stop" : "Start"}
    </button>
  );
}
```

Note: this drops the pre-existing `console.log` debug statements from `PillButton` (they were debug noise left in from earlier development, not part of any required behavior) — `console.warn`/`console.error` on actual failure paths are kept.

The rail-visibility pill's "Start/Stop" label is unchanged (relabeling it is explicitly out of scope per the Global Constraints) — only its color treatment changed, to the new tokens.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/App.tsx src/ui/components/TitleBar.tsx
git commit -m "feat: restyle TitleBar as a prompt bar with bracketed nav tabs"
```

---

## Task 5: Restyle the YourActivity dashboard card

**Files:**
- Modify: `src/ui/components/YourActivity.tsx` (full rewrite)

**Interfaces:**
- Consumes: theme tokens from Task 1. No change to `getSessions`/`Session` usage or fetch logic.

- [ ] **Step 1: Rewrite YourActivity.tsx**

Replace the full contents of `src/ui/components/YourActivity.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { getSessions, type Session } from "../api";

const YourActivity: React.FC = () => {
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSessions()
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const count = sessions?.length ?? 0;
  const mostRecentTitle = sessions?.[0]?.title;

  return (
    <div className="p-4 w-50 bg-panel border border-line rounded-sm text-phosphor">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[ACTIVITY]</h2>
      <div className="text-xs space-y-1">
        {sessions === null && (
          <p className="text-dim">
            loading<span className="cursor-blink">▌</span>
          </p>
        )}
        {sessions !== null && (
          <>
            <p>
              {count} meeting{count === 1 ? "" : "s"} recorded
            </p>
            {mostRecentTitle && <p className="text-dim">latest: {mostRecentTitle}</p>}
          </>
        )}
      </div>
    </div>
  );
};

export default YourActivity;
```

Fetch/count/most-recent-title logic is byte-identical to before — only the JSX markup and classNames changed (dropped the `•` bullet prefixes, which don't fit the log-line style; lowercased copy to match the app's new terminal voice).

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/YourActivity.tsx
git commit -m "style: restyle YourActivity dashboard card to terminal theme"
```

---

## Task 6: Restyle the Your Activity full page (log-line list, inverse-video selection)

**Files:**
- Modify: `src/ui/components/YourActivityPage.tsx` (full rewrite)

**Interfaces:**
- Consumes: theme tokens from Task 1. No change to `getSessions`/`Session` usage, loading/error/detail-view logic, or `formatRelativeTime`.

- [ ] **Step 1: Rewrite YourActivityPage.tsx**

Replace the full contents of `src/ui/components/YourActivityPage.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { getSessions, type Session } from "../api";

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

const YourActivityPage: React.FC = () => {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSessions()
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-3 text-phosphor">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-sm font-semibold tracking-wide uppercase">[ACTIVITY]</h1>
          <p className="text-xs text-dim">
            recent meetings and notes captured by the app
          </p>
        </div>
      </div>

      <div className="mt flex-1 bg-panel border border-line rounded-sm overflow-y-auto">
        {error && (
          <div className="h-full flex items-center justify-center text-xs text-red-400">
            failed to load activity: {error}
          </div>
        )}

        {!error && sessions === null && (
          <div className="h-full flex items-center justify-center text-xs text-dim">
            loading<span className="cursor-blink">▌</span>
          </div>
        )}

        {!error && sessions !== null && sessions.length === 0 && (
          <div className="h-full flex items-center justify-center text-xs text-dim">
            no meetings recorded yet<span className="cursor-blink">▌</span>
          </div>
        )}

        {!error && sessions !== null && sessions.length > 0 && !selected && (
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelectedId(s.id)}
                  className="w-full text-left px-4 py-2 text-xs hover:bg-signal hover:text-void transition"
                >
                  [{formatRelativeTime(s.created_at)}] {s.title}
                </button>
              </li>
            ))}
          </ul>
        )}

        {!error && selected && (
          <div className="h-full flex flex-col">
            <div className="px-4 py-2 border-b border-line flex items-center justify-between text-xs">
              <span>{selected.title}</span>
              <button
                onClick={() => setSelectedId(null)}
                className="text-dim hover:bg-signal hover:text-void px-1.5 py-0.5 rounded-sm transition"
              >
                [back]
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto px-4 py-3 text-xs whitespace-pre-wrap">
              {selected.notes}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

export default YourActivityPage;
```

The signature inverse-video interaction is on the list-row buttons (`hover:bg-signal hover:text-void`) and the `[back]` button — both flip to a solid phosphor-green block with void-colored text on hover, matching the TitleBar's active-tab treatment from Task 4.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/YourActivityPage.tsx
git commit -m "style: restyle YourActivityPage with log-line rows and inverse-video selection"
```

---

## Task 7: Restyle Health mini-card and HealthPage

**Files:**
- Modify: `src/ui/components/Health.tsx` (full rewrite)
- Modify: `src/ui/components/HealthPage.tsx` (full rewrite)

**Interfaces:**
- Consumes: theme tokens from Task 1. Hardcoded `cpuUsage`/`ramUsage` values and overall structure are unchanged (real stats are out of scope per Global Constraints).

- [ ] **Step 1: Rewrite Health.tsx**

Replace the full contents of `src/ui/components/Health.tsx`:

```tsx
import React from "react";

const Health: React.FC = () => {
  return (
    <div className="p-4 w-50 bg-panel border border-line rounded-sm text-phosphor">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[HEALTH]</h2>
      <div className="text-xs text-dim space-y-1">
        <p>cpu usage</p>
        <p>ram usage</p>
      </div>
    </div>
  );
};

export default Health;
```

- [ ] **Step 2: Rewrite HealthPage.tsx**

Replace the full contents of `src/ui/components/HealthPage.tsx`:

```tsx
import React from "react";

const HealthPage: React.FC = () => {
    const cpuUsage = 37;  // %
    const ramUsage = 62;
    const overall = Math.round((cpuUsage + ramUsage) / 2);

    return(
        <>
            <div className="h-full flex flex-col px-6 py-4 gap-3 text-phosphor">
                <div>
                    <h1 className="text-sm font-semibold tracking-wide uppercase">[HEALTH]</h1>
                    <p className="text-xs text-dim">
                        system usage while recording meetings
                    </p>
                </div>

                <div className="mt flex-1 flex flex-row items-center gap-6">
                    <div className="flex-[0.6] h-full rounded-sm bg-panel border border-line p-4 flex flex-col gap-4">
                        <div>
                            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">cpu usage</h2>
                            <p className="text-2xl font-semibold text-signal">
                                {cpuUsage}%
                            </p>
                            <p className="text-xs text-dim">
                                lower is better while recording. consider closing heavy apps if
                                this regularly exceeds ~80%.
                            </p>
                        </div>

                        <div>
                            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">memory usage</h2>
                            <p className="text-2xl font-semibold text-signal">
                                {ramUsage}%
                            </p>
                            <p className="text-xs text-dim">
                                high memory usage can affect transcription speed.
                            </p>
                        </div>
                    </div>

                    <div className="flex-[0.4] flex items-center justify-center">
                        <div className="relative w-70 h-70 rounded-full bg-panel border border-line flex items-center justify-center">
                            <div className="absolute inset-1 rounded-full border border-line" />
                                <div className="absolute inset-3 rounded-full border border-line" />
                                    <div className="text-center text-dim text-ms">
                                        overall load
                                    <div className="text-5xl font-semibold text-signal mt-1">
                                        {overall}%
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </>
    )
}

export default HealthPage
```

The circular load gauge (`rounded-full`) is a deliberate exception to the "sharp corners" rule — it's a real circular data visualization (a dial), not a container panel, per the Global Constraints note.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/Health.tsx src/ui/components/HealthPage.tsx
git commit -m "style: restyle Health card and HealthPage to terminal theme"
```

---

## Task 8: Restyle the rail widget (pill, Record, Pause, Play)

**Files:**
- Modify: `src/rail/RailApp.tsx` (targeted className edits only)
- Modify: `src/rail/components/Record.tsx` (full rewrite)
- Modify: `src/rail/components/Pause.tsx` (full rewrite)
- Modify: `src/rail/components/Play.tsx` (full rewrite)

**Interfaces:**
- Consumes: theme tokens from Task 1. No change to any recording/upload/status-flash logic — only color/border className values change.

- [ ] **Step 1: Read the current RailApp.tsx**

Read `src/rail/RailApp.tsx` first to locate the two spots you'll edit — its exact current formatting may differ slightly from what's shown below, so match by the distinctive surrounding text, not line numbers.

- [ ] **Step 2: Recolor the rail's outer pill container**

Find the outer container `<div>`'s className in the returned JSX — it currently contains the classes `rounded-[999px]`, `bg-neutral-900/90`, and `border-2 border-black-300`. Replace those three token-specific classes so the className becomes:

```
"h-full w-full overflow-hidden rounded-[999px] bg-void border border-signal/40 flex flex-col items-center gap-3 py-4 select-none"
```

(Keep every other class in that string — `h-full w-full overflow-hidden`, `flex flex-col items-center gap-3 py-4 select-none` — unchanged; only the background and border classes change.)

- [ ] **Step 3: Recolor the status dot**

Find the status-dot `<span>` at the end of the JSX — its className is built from a ternary keyed on `resultFlash`, using `bg-emerald-500` for success, `bg-red-500` for error, and `bg-gray-400` for idle, plus a `border border-black` (or similar dark border) and `rounded-full transition-colors`. Replace the color logic so it reads:

```tsx
<span
  className={
    "mt-auto h-2.5 w-2.5 rounded-full border border-void transition-colors " +
    (resultFlash === "success"
      ? "bg-signal"
      : resultFlash === "error"
      ? "bg-red-500"
      : "bg-dim")
  }
/>
```

(`bg-red-500` for the error state is unchanged — red still means failure, consistent with the recording-red convention. Only the success color, `border` color, and idle color change.)

Do not change `resultFlash`, the `useEffect` that clears it, or any of the fetch/record/stop logic in this file — this task is a pure recolor.

- [ ] **Step 4: Rewrite Record.tsx**

Replace the full contents of `src/rail/components/Record.tsx`:

```tsx
import React from "react";

interface RecordProps {
    onClick?: () => void;
    isRecording?: boolean;
}

const Record: React.FC<RecordProps> = ({ onClick, isRecording }) => {
    return (
        <button 
            onClick={onClick} 
            className={"h-10 w-10 rounded-full border-2 border-line shadow-sm transition " +
            "hover:brightness-110 active:scale-95 focus:outline-none " +
            "focus:ring-2 focus:ring-signal " +
            (isRecording ? "bg-red-600" : "bg-red-500")}
        />
    )
}

export default Record;
```

(The fill stays red in both states — recording is a universal-convention color, unchanged per the spec. Only the border and focus-ring colors moved to the new tokens.)

- [ ] **Step 5: Rewrite Pause.tsx**

Replace the full contents of `src/rail/components/Pause.tsx`:

```tsx
import React from "react";

interface PauseProps {
    onClick?: () => void;
    disabled?: boolean;
}

const Pause: React.FC<PauseProps> = ({ onClick, disabled }) => {
    return (
        <button 
            onClick={disabled ? undefined : onClick}
            disabled={disabled} 
            className={"grid place-items-center h-10 w-10 rounded-sm border-2 border-signal/60 bg-panel transition hover:brightness-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-signal " + (disabled ? "opacity-40 cursor-not-allowed" : "")}>
            <div className="flex gap-1">
                <div className="h-5 w-2 bg-signal rounded-[2px]" />
                <div className="h-5 w-2 bg-signal rounded-[2px]" />
            </div>
        </button>
    )
}

export default Pause;
```

Note: this also fixes a pre-existing typo in the original file (`activate:scale-95`, which is not a real Tailwind class and was silently doing nothing) to the correct `active:scale-95`.

- [ ] **Step 6: Rewrite Play.tsx**

Replace the full contents of `src/rail/components/Play.tsx`:

```tsx
import React from "react";

interface PlayProps {
    onClick?: () => void;
    disabled?: boolean;
}

const Play: React.FC<PlayProps> = ({ onClick, disabled }) => {
    return (
        <button
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            className={"grid place-items-center h-10 w-10 rounded-sm border-2 border-signal/60 bg-panel transition hover:brightness-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-signal "+(disabled ? "opacity-40 cursor-not-allowed" : "")}
        >
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-signal">
                <path d="M8 5v14l11-7z" />
            </svg>
        </button>
    )
}

export default Play;
```

- [ ] **Step 7: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/rail/RailApp.tsx src/rail/components/Record.tsx src/rail/components/Pause.tsx src/rail/components/Play.tsx
git commit -m "style: restyle rail widget (pill, status dot, Record/Pause/Play) to terminal theme"
```

---

## Task 9: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Automated checks**

Run: `npx tsc -b --noEmit && npx vite build`
Expected: both succeed with no errors.

Run: `cd backend && python -m pytest tests/ -v`
Expected: all backend tests still pass (this pass touched no backend code, so this is a regression check, not new coverage).

- [ ] **Step 2: Start the backend and frontend**

Run: `cd backend && python -m uvicorn app.server:app --reload --port 8000` (one terminal)
Run: `npm run build && npm run dev:electron` (another terminal)

- [ ] **Step 3: Visually confirm the redesign**

Expected, across every surface:
- TitleBar reads as a prompt bar: app name with a blinking cursor, `[dashboard]` `[activity]` `[health]` nav with the current tab shown in solid phosphor-green/void inverse video.
- Dashboard panels (Activity, Health, Status, Chat) all share the same flat panel style: `bg-panel`, hairline `border-line`, sharp corners, bracketed `[EYEBROW]` headers — no rounded-xl, no shadows, no blur.
- Your Activity full page: list rows read as `[2h ago] Title` log lines; hovering/selecting a row inverts it to solid phosphor-green with void text; empty state shows a blinking cursor.
- Health page: hardcoded stats still show (37%/62%), now in the new palette; the circular gauge is the one deliberately-kept `rounded-full` element.
- Status panel shows `● backend: online` in phosphor green while the backend is running.
- Chat's input is visibly disabled (greyed placeholder, not focusable/typeable) and pressing Enter while attempting to interact with it does nothing — no page reload/blank.
- Rail widget: pill has a thin phosphor-green ring on a near-black fill; Pause/Play icons are phosphor-green-outlined; Record button is still red; the status dot still flashes green/red/gray (now signal/red-500/dim) on `/process` results, unchanged from the prior pass's behavior.

- [ ] **Step 4: Confirm Status reacts to the backend going down**

Stop the backend process (Ctrl+C in its terminal). Within ~15 seconds (the poll interval), the Status panel should flip to `○ backend: offline`. Restart the backend; within ~15 seconds it should flip back to `● backend: online`.

- [ ] **Step 5: Confirm reduced motion is respected**

Enable "reduce motion" at the OS level (Windows: Settings → Accessibility → Visual effects → Animation effects, off) or emulate `prefers-reduced-motion: reduce` via Chrome DevTools' Rendering tab (available through Electron's DevTools, already opened by `main.js` in dev). Confirm the blinking cursor (`▌`) next to the app name and in empty states renders as a static solid character, not blinking.

No commit for this task — it's verification only. If any step fails, file it as a follow-up rather than silently patching outside this plan's scope.

---

## Self-Review Notes

- **Spec coverage:** color/type/layout/signature system (Task 1), Status real health check (Task 2), Chat form-bug fix (Task 3), TitleBar prompt-bar + nav (Task 4), YourActivity card (Task 5), YourActivityPage list/detail with inverse-video signature (Task 6), Health card + HealthPage (Task 7), rail widget (Task 8), manual verification including reduced-motion (Task 9) — every spec section has a corresponding task. `DashboardCards.tsx` was in the spec's component table but turned out to need no changes on inspection (it's a pure layout wrapper with no color/token classNames of its own) — dropped from the file list rather than left as a no-op task.
- **Placeholder scan:** no TBD/TODO markers; all steps include full code or precise, anchored find/replace instructions.
- **Type consistency:** `checkHealth(): Promise<boolean>` (Task 2) matches its only consumer in `Status.tsx` (same task). `TitleBar`'s new `page: MainPage` prop (Task 4) is added at both its definition and its one call site in `App.tsx` within the same task. Color/token class names (`bg-void`, `bg-panel`, `border-line`, `text-phosphor`, `text-dim`, `bg-signal`/`text-signal`/`border-signal`, `.cursor-blink`) are used identically across Tasks 2–8 and match exactly what Task 1 defines.
