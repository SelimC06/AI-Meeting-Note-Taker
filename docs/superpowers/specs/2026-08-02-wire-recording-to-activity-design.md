# Wire recording → notes → activity, plus bug fixes

Date: 2026-08-02

## Context

The rail widget already records screen/system/mic audio and POSTs to the
backend's `/process` endpoint, which mixes/muxes the media, transcribes it,
and returns generated meeting notes. Today that response is only logged to
devtools console — nothing in the main window shows it, and nothing persists
across app restarts. The main window's `YourActivity` card and
`YourActivityPage` are static placeholders with no data source.

Two concrete bugs were also found while reading the backend:

1. [`server.py`](../../../backend/app/server.py) references `txt_path`
   unconditionally in the summarization `try` block, but it's only assigned
   inside the `if stop_recording_and_transcribe is not None:` branch above
   it. If that import failed, this raises `NameError`, silently caught by
   the broad `except Exception`, and falls through to degraded stub notes.
2. [`LLaVA_summarize.py`](../../../backend/app/LLaVA_summarize.py) builds the
   `options` dict twice; the first definition is dead code.

## Goal

Make a completed recording show up as a persisted, browsable entry in
**Your Activity**, and fix the two bugs above. Everything else surfaced in
the earlier review (Health real stats, Chat backend, DB-backed persistence,
security hardening, per-user auth scoping) is explicitly out of scope for
this plan — each is its own future spec.

## Non-goals

- No database. Persistence is a JSON index file, chosen so this doesn't
  duplicate the separately-deferred "persistence layer" work, while still
  giving `Your Activity` something real to read.
- No Markdown rendering library. Notes are shown as preformatted text.
- No auth-based scoping of activity entries — single-user desktop app for
  now.
- No changes to Health or Chat.
- No new frontend test framework — verification is manual (see Testing).

## Persistence approach

The backend maintains a JSON index at
`backend/app/uploads/sessions_index.json`: a list of records shaped as

```json
{
  "id": "15cdc2ca1c5e4e2a9b941d0abab839f1",
  "created_at": "2026-08-02T14:03:11Z",
  "title": "Sprint Planning",
  "notes": "# Title\n...",
  "video_path": "backend/app/uploads/<id>/final.webm"
}
```

`POST /process` appends a record after successfully producing `notes`. A new
`GET /sessions` endpoint reads the index and returns it sorted newest-first.
Missing/empty index file → `[]`, not an error.

This keeps the API shape stable if a real database is introduced later —
`GET /sessions` can be re-implemented against SQLite without the frontend
changing.

### Title extraction

`_extract_title(notes: str) -> str` pulls the first Markdown `# `-heading
line out of `notes` (handling both `# Title` and `# Title: Zoom Meeting`
forms already produced by the pipeline) and strips a leading `Title:`
prefix. Falls back to `"Untitled meeting"` if no heading is found.

## Backend changes

Files: `backend/app/server.py`, `backend/app/LLaVA_summarize.py`

1. **Fix the `txt_path` bug.** Only attempt the LLaVA/whisper summarization
   step when transcription actually ran and produced a path; otherwise skip
   straight to the existing stub-notes fallback. No behavior change when
   transcription succeeds.
2. **Remove the duplicate `options` dict** in `LLaVA_summarize.py` (keep the
   second, correct definition that includes `num_gpu`).
3. **Add index helpers**: `load_sessions() -> list[dict]` and
   `append_session(record: dict) -> None`, reading/writing
   `sessions_index.json` under `STORE`.
4. **`POST /process`**: after `notes` is finalized, build a record
   (`id=session.name`, `created_at=now (UTC, ISO 8601)`,
   `title=_extract_title(notes)`, `notes`, `video_path=str(final_path)`) and
   append it to the index.
5. **`GET /sessions`**: returns `load_sessions()` sorted by `created_at`
   descending.

## Frontend changes

1. **`src/ui/api.ts`** (new): thin fetch wrapper, `getSessions(): Promise<Session[]>`
   hitting `${BACKEND_URL}/sessions`, sharing the same `VITE_MEETING_API_URL`
   env convention already used in `RailApp.tsx`.
2. **`YourActivityPage`**: on mount, fetch sessions.
   - Loading: simple text/spinner state.
   - Empty: keep existing `"No meetings recorded yet."` copy.
   - Error: plain inline error message, no retry logic beyond a manual
     re-fetch on next mount.
   - Success: list of sessions (title + relative time, e.g. "2h ago");
     selecting one shows its full `notes` as preformatted text in the
     existing panel.
3. **`YourActivity`** (dashboard mini-card): on mount, fetch sessions and
   show a count ("3 meetings recorded") plus the most recent title in place
   of the current static bullets. Click-through to the full page is already
   wired via `onChangePage`.
4. **`RailApp`**: after `/process` resolves, reflect success/failure
   directly on the rail (status dot flashes green on success, red on
   failure, then returns to idle gray) instead of only `console.log`. No
   cross-window IPC — `YourActivityPage`/`YourActivity` simply re-fetch
   whenever they mount, i.e. whenever the user navigates to that tab.

## Data flow summary

```
Rail record → stop → POST /process
    → backend mixes/muxes/transcribes/summarizes
    → notes built, title extracted, record appended to sessions_index.json
    → response returned to rail (drives status-dot flash)

User opens "Your Activity" tab → GET /sessions → render list
    → select entry → show stored notes text
```

## Error handling

- `/process` keeps its existing degrade-to-stub-notes behavior on pipeline
  failure — unchanged, and stub notes still get appended to the index so a
  failed-but-recovered session still shows up.
- `/sessions` never 500s on a missing index file.
- Frontend never blocks on a failed fetch indefinitely — shows the error
  state and lets the user navigate away/back to retry.

## Testing

- **Backend (pytest, new)**:
  - `_extract_title` against both title formats and the no-heading fallback.
  - `load_sessions`/`append_session` round-trip against a temp directory.
  - A `/process` case with `stop_recording_and_transcribe` monkeypatched to
    `None`, asserting no `NameError` and that stub notes are returned and
    appended to the index.
- **Frontend**: no test framework exists in this repo yet; introducing one
  is out of scope here. Verification is manual: run the Electron app,
  record a short clip via the rail, confirm the status dot flashes and the
  entry appears with correct title/notes in Your Activity (both the
  dashboard card and full page).
