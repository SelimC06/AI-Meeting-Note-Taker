# Terminal/phosphor frontend redesign

Date: 2026-08-02

## Context

The frontend was built as generic dark-mode Tailwind: `neutral-900` panels, `rounded-xl` cards, default grays, no consistent type or color system. A prior pass ([2026-08-02-wire-recording-to-activity-design.md](2026-08-02-wire-recording-to-activity-design.md)) wired real data into the dashboard and activity views but left the visual language untouched, and left two functional problems in place:

1. `src/ui/components/Chat.tsx` renders a `<form>` with a text input and no `onSubmit` handler and no submit button. Pressing Enter triggers the browser's default form submission (a GET navigation), which in Electron risks blanking/reloading the window.
2. `src/ui/components/Status.tsx` ("Status (Offline/Online)") is a toggle switch wired to nothing but its own local state — it looks like a live indicator but reports nothing real.

This spec covers a combined visual + functional pass: give the whole frontend (main window and the floating rail widget) an intentional terminal/phosphor identity, and fix both issues above as part of the same pass, in the app's new voice.

## Goal

Every surface in `src/ui/` and `src/rail/` reads as one deliberate design — a technical, terminal-inspired control surface — instead of a stack of default Tailwind components. `Status` becomes a real backend-health indicator. `Chat` can no longer trigger a default form submission.

## Non-goals (explicitly deferred, per prior scoping conversation)

- Health page real system stats — stays on hardcoded numbers, gets the visual treatment only.
- Recording feedback improvements (error surfacing, uploading/processing state, duration timer) — not touched.
- TitleBar's rail-visibility "Start/Stop" pill relabeling — not touched (still toggles rail visibility, keeps current label).
- No new backend endpoints except reusing the existing `GET /health`.
- No login UI, no video playback, no resizable-layout overhaul, no Chat backend.
- No frontend test framework — this repo still has none; verification stays manual.

## Design System

### Color

Six tokens, defined once and shared by both Vite entry points (main window and rail):

| Token | Hex | Use |
|---|---|---|
| `bg-void` | `#0A0F0C` | Window/page background |
| `bg-panel` | `#10160E` | Card/panel surface (one step up from void) |
| `line-dim` | `#1F2E1C` | Hairline borders, dividers |
| `text-phosphor` | `#B9F5C4` | Primary text |
| `text-dim` | `#5C7A5E` | Secondary text: timestamps, captions, meta |
| `accent-signal` | `#39FF88` | Active tab, online status, success flash, selection highlight — spent deliberately, not everywhere |

Recording red is unchanged from the current `red-500`/`red-600` Tailwind values already used by `Record.tsx` and the rail's status-dot flash (`bg-red-500`) — red already means "recording" in this app; this pass doesn't introduce a second red.

### Type

One family for every role: **JetBrains Mono**, self-hosted via the `@fontsource/jetbrains-mono` npm package (no network font fetch, renders identically on any machine). Two weights carry the whole app://
- 500/600 — labels, nav, headers, panel eyebrows
- 400 — body text and data

No second (sans/serif) typeface is introduced — mixing families would dilute the terminal identity that's the point of this pass.

Scale (tight, for an 800×450 window): `11px` captions, `13px` body, `15px` emphasized/list titles, `20px` page headers. Uppercase labels get a small positive letter-spacing (`0.04em`) so they read as commands, not decoration.

### Layout

- **TitleBar** becomes a prompt bar: app name with a blinking block cursor (`▌`), nav rendered as bracketed commands (`[dashboard]` `[activity]` `[health]`), the active tab shown in **inverse video** (solid `accent-signal` background, `bg-void`-colored text) instead of a subtle color shift. The existing minimize/close window controls and the rail-visibility pill stay functionally unchanged, restyled to match.
- **Dashboard panels** (`YourActivity`, `Health`, `Status`, `Chat`) get sharp corners (`2px` radius, not `rounded-xl`), `line-dim` hairline borders, no drop shadows, and bracket-style eyebrow headers (`[ACTIVITY]`, `[HEALTH]`, `[STATUS]`) in place of plain prose `<h2>` text.
- **Activity list rows** (`YourActivityPage`) render like log lines: `[2h ago] Sprint Planning`. Selecting a row inverts it to the same `accent-signal`/`bg-void` treatment as the active tab (the signature interaction, see below).
- **Status panel** becomes a real backend-health LED: a filled `accent-signal` square/dot + `● backend: online` when `GET /health` succeeds, an outlined dim dot + `○ backend: offline` when it doesn't.
- **Chat panel** becomes a disabled terminal input line: placeholder text `> ask about this meeting (coming soon)`, input and any submit control disabled, so no submission — successful or default — can ever fire.
- **Rail widget** keeps its floating pill/capsule shape (a good, unobtrusive always-on-top affordance) — restyled inside: `bg-void` panel, a thin `accent-signal` ring instead of the current plain border, Pause/Play icon buttons recolored to `accent-signal`-outlined (currently black-on-gray), Record button unchanged (red, universal convention). The status-dot flash logic already built (green/red/gray) is recolored to the new tokens, not re-architected.

ASCII sketch, main window:

```
┌──────────────────────────────────────────────────┐
│ meeting-note-taker▌      [dashboard][activity][health] ⏵ _ x │
├──────────────────────────────────────────────────┤
│ ┌─[ACTIVITY]───────┐ ┌─[HEALTH]──────┐ ┌─[STATUS]┐│
│ │ 3 meetings        │ │ cpu   37%     │ │● backend││
│ │ Latest: Standup   │ │ ram   62%     │ │  online ││
│ └────────────────────┘ └───────────────┘ └─────────┘│
│ ┌─[CHAT]───────────────────────────────────────┐  │
│ │ > ask about this meeting (coming soon)        │  │
│ └────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

ASCII sketch, rail (unchanged shape, restyled fill):

```
   ╭────╮
   │ ⬤  │  ← record (red, unchanged)
   │────│
   │ ⏸  │  ← accent-signal outline
   │ ⏵  │  ← accent-signal outline
   │    │
   │ ●  │  ← status dot: green/red/gray flash (recolored)
   ╰────╯
```

### Signature element

**Inverse-video selection.** Every interactive row or tab, on hover/active, flips to a solid `accent-signal` block with `bg-void`-colored text — exactly like selecting text in a real terminal. This is the one consistent, memorable interaction spanning the TitleBar nav, the activity list, and (where relevant) the dashboard panel headers. It's paired sparingly with a blinking block cursor (`▌`) next to the app name and after empty-state lines (e.g. `no meetings recorded yet▌`) — not used anywhere else, so it stays a signal rather than noise.

### Motion and accessibility floor

- The blinking cursor is a CSS `opacity` animation, disabled under `prefers-reduced-motion: reduce` (renders as a static solid cursor instead).
- Focus states use a visible `accent-signal` outline — fits the theme and satisfies keyboard-navigation visibility.
- Inverse-video selection provides its own strong contrast affordance for both mouse and keyboard focus.

## Component-by-component changes

| File | Change |
|---|---|
| `src/theme.css` (new) | `@theme` block defining the six color tokens, `@fontsource/jetbrains-mono` import, base font-family assignment. Imported by both `src/ui/index.css` and `src/rail/rail.css`. |
| `src/ui/index.css`, `src/rail/rail.css` | Add `@import "../theme.css"` (or equivalent relative path) before/alongside the existing `@import "tailwindcss"`. |
| `src/ui/components/TitleBar.tsx` | Prompt-bar styling, bracketed nav labels, inverse-video active tab, blinking cursor next to app name. Minimize/close/rail-pill controls restyled, not re-logic'd. |
| `src/ui/components/DashboardCards.tsx` | Layout wrapper restyling only (panel spacing/grid) — no logic change. |
| `src/ui/components/YourActivity.tsx` | Panel restyle: `[ACTIVITY]` eyebrow header, log-line-style count/latest-title text. Existing fetch/count/title logic unchanged. |
| `src/ui/components/YourActivityPage.tsx` | Panel restyle, list rows as log lines, inverse-video selection on hover/selected row, blinking-cursor empty state. Existing fetch/loading/error/detail-view logic unchanged. |
| `src/ui/components/Health.tsx`, `HealthPage.tsx` | Visual restyle only — `[HEALTH]` eyebrow, new tokens. Hardcoded `cpuUsage`/`ramUsage` values and layout structure otherwise unchanged (real stats explicitly deferred). |
| `src/ui/components/Status.tsx` | Rewritten: drops the fake toggle entirely, polls `GET /health` (via a new `checkHealth()` helper in `src/ui/api.ts`) on an interval, renders `● backend: online` / `○ backend: offline` in the new token colors. |
| `src/ui/components/Chat.tsx` | Rewritten: `<form>` replaced with a plain `<div>` (no submit path at all — not just a disabled form, since a disabled form can still theoretically be submitted via other means; removing the `<form>` element removes the class of bug entirely). Input and any button rendered `disabled`, placeholder `> ask about this meeting (coming soon)`. |
| `src/ui/api.ts` | Add `checkHealth(): Promise<boolean>` — `fetch` against `${BACKEND_URL}/health`, returns whether the response was ok, catches network errors as `false`. |
| `src/rail/RailApp.tsx` | Token/color updates only to existing className strings (panel background, ring, status-dot colors) — no change to recording/upload logic (already correct from the prior pass). |
| `src/rail/components/Record.tsx` | Border/ring color updated to new tokens; fill stays red (recording convention preserved). |
| `src/rail/components/Pause.tsx`, `Play.tsx` | Icon/border recolored from black-on-gray to `accent-signal`-outlined on `bg-panel`. |
| `package.json` | Add `@fontsource/jetbrains-mono` dependency. |

## Error handling

- `checkHealth()` never throws to its caller — network failure or non-2xx both resolve to `false`, so `Status` always renders a definite online/offline state, never a stuck loading spinner for a simple health check.
- Removing the `<form>` element from `Chat.tsx` eliminates the default-submission bug at the source rather than papering over it with `preventDefault()` on a still-live form.

## Testing

No frontend test framework exists in this repo (unchanged from the prior spec's conclusion) — introducing one is out of scope here too. Verification is manual:
- Run the Electron app, visually confirm every panel (Dashboard cards, Activity list/detail, Health, Status, Chat, TitleBar, rail) reflects the new token system consistently.
- Confirm `Status` flips between online/offline when the backend is stopped/started.
- Confirm `Chat`'s input cannot be typed into or submitted, and pressing Enter while it's focused does nothing (no navigation/reload).
- Confirm the blinking cursor stops animating with `prefers-reduced-motion` simulated (via OS setting or browser devtools emulation).
- Confirm keyboard Tab order reaches TitleBar nav and Activity list rows with a visible `accent-signal` focus outline.
