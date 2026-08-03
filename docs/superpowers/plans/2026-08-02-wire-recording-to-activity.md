# Wire Recording to Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a completed rail recording show up as a persisted, browsable entry in "Your Activity", and fix the two known backend bugs (`txt_path` NameError risk, duplicate `options` dict).

**Architecture:** Backend gains a small `sessions_store` module (JSON-file-backed index) and a `GET /sessions` endpoint; `POST /process` appends to the index after building notes. Frontend gains a thin `api.ts` fetch client consumed by `YourActivityPage` and `YourActivity`, and `RailApp` gets a status-dot flash on `/process` success/failure. No database, no Markdown renderer, no cross-window IPC — pages simply re-fetch on mount.

**Tech Stack:** FastAPI/Python backend (pytest for tests), React 19/TypeScript/Vite frontend, Tailwind for styling.

## Global Constraints

- No new runtime dependency for Markdown rendering — notes render as preformatted text.
- No database — persistence is the JSON index file `backend/app/uploads/sessions_index.json`.
- No auth-based scoping of sessions.
- `created_at` is stored as UTC ISO 8601 (`datetime.now(timezone.utc).isoformat()`).
- Backend tests use `pytest` + FastAPI's `TestClient` (from `fastapi.testclient`, backed by `httpx` which is already a dependency).

---

## Task 1: `sessions_store` module — title extraction and JSON index I/O

**Files:**
- Create: `backend/app/sessions_store.py`
- Test: `backend/tests/test_sessions_store.py`
- Modify: `requirements.txt` (add `pytest`)

**Interfaces:**
- Produces:
  - `extract_title(notes: str) -> str`
  - `load_sessions(store_dir: Path) -> list[dict]`
  - `append_session(store_dir: Path, record: dict) -> None`
  - Index filename constant: `SESSIONS_INDEX_FILENAME = "sessions_index.json"`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_sessions_store.py`:

```python
import json
from pathlib import Path

import pytest

from app.sessions_store import extract_title, load_sessions, append_session


def test_extract_title_plain_heading():
    notes = "# Sprint Planning\n\n## Key Points\n- (bullet)\n"
    assert extract_title(notes) == "Sprint Planning"


def test_extract_title_with_prefix():
    notes = "# Title: Zoom Meeting\n\n# Transcript (auto)\nhello\n"
    assert extract_title(notes) == "Zoom Meeting"


def test_extract_title_no_heading_falls_back():
    notes = "no heading here at all\njust text\n"
    assert extract_title(notes) == "Untitled meeting"


def test_extract_title_empty_string_falls_back():
    assert extract_title("") == "Untitled meeting"


def test_load_sessions_missing_file_returns_empty_list(tmp_path: Path):
    assert load_sessions(tmp_path) == []


def test_append_and_load_round_trip(tmp_path: Path):
    record1 = {
        "id": "aaa",
        "created_at": "2026-08-01T10:00:00+00:00",
        "title": "First",
        "notes": "# First\n",
        "video_path": "aaa/final.webm",
    }
    record2 = {
        "id": "bbb",
        "created_at": "2026-08-02T10:00:00+00:00",
        "title": "Second",
        "notes": "# Second\n",
        "video_path": "bbb/final.webm",
    }

    append_session(tmp_path, record1)
    append_session(tmp_path, record2)

    loaded = load_sessions(tmp_path)
    assert len(loaded) == 2
    assert {r["id"] for r in loaded} == {"aaa", "bbb"}


def test_load_sessions_tolerates_corrupt_file(tmp_path: Path):
    (tmp_path / "sessions_index.json").write_text("not json", encoding="utf-8")
    assert load_sessions(tmp_path) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_sessions_store.py -v`
Expected: FAIL/ERROR — `ModuleNotFoundError: No module named 'app.sessions_store'`

- [ ] **Step 3: Write the implementation**

Create `backend/app/sessions_store.py`:

```python
from __future__ import annotations
import json
from pathlib import Path
from typing import List

SESSIONS_INDEX_FILENAME = "sessions_index.json"


def extract_title(notes: str) -> str:
    """Pull the first Markdown '# ' heading out of notes as a title."""
    for line in notes.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            if title.lower().startswith("title:"):
                title = title[len("title:"):].strip()
            if title:
                return title
    return "Untitled meeting"


def _index_path(store_dir: Path) -> Path:
    return store_dir / SESSIONS_INDEX_FILENAME


def load_sessions(store_dir: Path) -> List[dict]:
    """Read the sessions index. Missing or corrupt file -> empty list."""
    path = _index_path(store_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(data, list):
        return []
    return data


def append_session(store_dir: Path, record: dict) -> None:
    """Append one session record to the index, creating it if needed."""
    sessions = load_sessions(store_dir)
    sessions.append(record)
    _index_path(store_dir).write_text(
        json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8"
    )
```

- [ ] **Step 4: Add pytest to requirements.txt**

Edit `requirements.txt`, append a line:

```
pytest
```

Install it: `pip install pytest`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_sessions_store.py -v`
Expected: PASS (6 passed)

- [ ] **Step 6: Commit**

```bash
git add backend/app/sessions_store.py backend/tests/test_sessions_store.py requirements.txt
git commit -m "feat: add sessions_store module for JSON-backed session index"
```

---

## Task 2: Fix the `txt_path` NameError bug and duplicate `options` dict

**Files:**
- Modify: `backend/app/server.py:242-299` (the `/process` summarization block)
- Modify: `backend/app/LLaVA_summarize.py:87-97` (duplicate `options` dict)
- Test: `backend/tests/test_server.py`

**Interfaces:**
- Consumes: nothing new from Task 1 yet (wired in Task 3).
- Produces: `/process` no longer references `txt_path` unless transcription actually ran.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_server.py`:

```python
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.server as server_module
from app.server import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Redirect uploads to a temp dir so tests don't pollute backend/app/uploads
    monkeypatch.setattr(server_module, "STORE", tmp_path)
    tmp_path.mkdir(exist_ok=True)
    return TestClient(app)


def _tiny_webm_bytes() -> bytes:
    # Not a real playable video; ffprobe_ok will reject it, which is fine —
    # this test exercises the "no valid screen video" 400 path plus confirms
    # the app imports and boots without the txt_path NameError blowing up
    # module-level state.
    return b"not-a-real-webm"


def test_process_rejects_invalid_screen_upload(client: TestClient):
    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(_tiny_webm_bytes()), "video/webm")},
    )
    assert resp.status_code == 400


def test_process_falls_back_to_stub_notes_without_transcription(client, monkeypatch):
    # Force the "transcription helper unavailable" path that previously
    # caused a NameError on txt_path.
    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "notes" in body
    assert "session" in body
```

- [ ] **Step 2: Run test to verify the fallback test fails**

Run: `cd backend && python -m pytest tests/test_server.py -v`
Expected: `test_process_rejects_invalid_screen_upload` PASSES already (ffprobe rejects garbage bytes). `test_process_falls_back_to_stub_notes_without_transcription` FAILS with `NameError: name 'txt_path' is not defined`, confirming the bug.

- [ ] **Step 3: Fix `server.py`**

In `backend/app/server.py`, replace the block starting at the `notes: str = ""` line (around line 242) through the end of the LLaVA `try/except` (around line 279):

```python
    notes: str = ""
    # 5) (optional) run your pipeline if available
    txt_path: Optional[str] = None
    if stop_recording_and_transcribe is not None:
        # Use your helper on the final muxed video; request frames & transcript
        txt_path, _ = stop_recording_and_transcribe(
            video_path=str(final_path),
            transcript_prefix=str(session / "transcript_"),
            model_name="tiny.en",
            separate_tracks=False,
            extract_frames_after=True,
            frames_mode="uniform",
            frames_out_dir=str(session / "frames"),
            every_n_seconds=5.0,
            scale_width=960,
            image_ext="png",
            quality=2,
            max_frames=3,
        )

    if txt_path is not None:
        try:
            if llava_complete is None:
                raise RuntimeError("llava_complete import is None (summarizer missing)")

            notes = llava_complete(
                raw_txt_path=txt_path,
                out_path=str(session / "notes.md"),
                frame_paths=selected_paths,
                max_images=min(3, len(selected_paths)),
                max_image_px=1280,
                jpeg_quality=80,
                max_chars=12000,
                stream=False,
                num_ctx=8192,
                num_predict=800,
                temperature=0.3,
            )
        except Exception as e:
            log(f"pipeline failed, returning stub notes: {e}")
```

This only calls `llava_complete` (and only ever references `txt_path`) when transcription actually produced one. When `stop_recording_and_transcribe` is `None`, `txt_path` stays `None`, the `if txt_path is not None:` block is skipped entirely, and execution falls straight to the existing `if not notes:` fallback below it (unchanged).

- [ ] **Step 4: Fix the duplicate `options` dict in `LLaVA_summarize.py`**

In `backend/app/LLaVA_summarize.py`, remove the first `options = {...}` block (lines 87-91) and keep only the second one (lines 92-97), so the function reads:

```python
    options = {
        "temperature": float(temperature),
        "num_predict": int(num_predict),
        "num_ctx": int(num_ctx),
        "num_gpu": 0,
    }
```

(i.e. delete the earlier three-key dict that gets immediately overwritten.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_server.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git add backend/app/server.py backend/app/LLaVA_summarize.py backend/tests/test_server.py
git commit -m "fix: guard txt_path usage in /process, remove duplicate options dict"
```

---

## Task 3: `GET /sessions` endpoint + append-on-success wiring

**Files:**
- Modify: `backend/app/server.py` (imports, `/process` return block, new endpoint)
- Test: `backend/tests/test_server.py` (extend)

**Interfaces:**
- Consumes: `extract_title`, `load_sessions`, `append_session` from `app.sessions_store` (Task 1).
- Produces: `GET /sessions` → `200` with `list[dict]` (newest first), each dict shaped `{id, created_at, title, notes, video_path}`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_server.py`:

```python
from datetime import datetime, timezone


def test_sessions_empty_when_no_index(client: TestClient):
    resp = client.get("/sessions")
    assert resp.status_code == 200
    assert resp.json() == []


def test_process_appends_to_sessions_and_get_sessions_returns_it(client, monkeypatch):
    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    resp = client.post(
        "/process",
        files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
    )
    assert resp.status_code == 200
    session_id = resp.json()["session"]

    sessions_resp = client.get("/sessions")
    assert sessions_resp.status_code == 200
    sessions = sessions_resp.json()
    assert len(sessions) == 1
    entry = sessions[0]
    assert entry["id"] == session_id
    assert entry["notes"] == resp.json()["notes"]
    assert "created_at" in entry
    # created_at must be parseable ISO 8601
    datetime.fromisoformat(entry["created_at"])
    assert entry["title"]  # non-empty, extracted or fallback


def test_sessions_returns_newest_first(client, monkeypatch):
    monkeypatch.setattr(server_module, "stop_recording_and_transcribe", None)
    monkeypatch.setattr(server_module, "llava_complete", None)

    def fake_save_upload(dst_dir, uf, name):
        out = dst_dir / name
        out.write_bytes(b"fake video bytes")
        return out

    def fake_mux(video, audio, out_path):
        out_path.write_bytes(b"fake final video")
        return out_path

    monkeypatch.setattr(server_module, "save_upload", fake_save_upload)
    monkeypatch.setattr(server_module, "mux_video_audio", fake_mux)

    ids = []
    for _ in range(2):
        resp = client.post(
            "/process",
            files={"screen": ("screen.webm", io.BytesIO(b"x"), "video/webm")},
        )
        ids.append(resp.json()["session"])

    sessions = client.get("/sessions").json()
    assert [s["id"] for s in sessions] == list(reversed(ids))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_server.py -v`
Expected: FAIL — `GET /sessions` returns `404 Not Found` (route doesn't exist yet), and `/process` doesn't append anything.

- [ ] **Step 3: Wire up the index in `server.py`**

Add the import near the top of `backend/app/server.py`, alongside the other `from .` imports:

```python
from datetime import datetime, timezone
from .sessions_store import extract_title, load_sessions, append_session
```

Replace the final `return` block of `/process` (the last 5 lines, `return {"notes": notes, ...}`) with:

```python
    record = {
        "id": session.name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "title": extract_title(notes),
        "notes": notes,
        "video_path": str(final_path),
    }
    append_session(STORE, record)

    return {
        "notes": notes,
        "video_path": str(final_path),
        "session": session.name,
    }
```

Add the new endpoint near the other `@app.get` routes (e.g. right after `/debug/ollama`):

```python
@app.get("/sessions")
def sessions():
    return sorted(load_sessions(STORE), key=lambda r: r.get("created_at", ""), reverse=True)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/ -v`
Expected: PASS (all tests in `test_sessions_store.py` and `test_server.py`)

- [ ] **Step 5: Commit**

```bash
git add backend/app/server.py backend/tests/test_server.py
git commit -m "feat: add GET /sessions endpoint, append session record on /process success"
```

---

## Task 4: Frontend API client

**Files:**
- Create: `src/ui/api.ts`

**Interfaces:**
- Produces:
  - `type Session = { id: string; created_at: string; title: string; notes: string; video_path: string }`
  - `getSessions(): Promise<Session[]>`
  - `BACKEND_URL` constant (same `VITE_MEETING_API_URL` env convention as `RailApp.tsx`)

- [ ] **Step 1: Create the API client**

Create `src/ui/api.ts`:

```typescript
export type Session = {
  id: string;
  created_at: string;
  title: string;
  notes: string;
  video_path: string;
};

export const BACKEND_URL =
  import.meta.env.VITE_MEETING_API_URL ?? "http://localhost:8000";

export async function getSessions(): Promise<Session[]> {
  const resp = await fetch(`${BACKEND_URL}/sessions`);
  if (!resp.ok) {
    throw new Error(`Failed to load sessions: ${resp.status}`);
  }
  return (await resp.json()) as Session[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no new type errors (file has no callers yet, so this just checks the file itself is valid TypeScript).

- [ ] **Step 3: Commit**

```bash
git add src/ui/api.ts
git commit -m "feat: add frontend API client with getSessions()"
```

---

## Task 5: Wire `YourActivityPage` to real data

**Files:**
- Modify: `src/ui/components/YourActivityPage.tsx` (full rewrite of the component body)

**Interfaces:**
- Consumes: `getSessions`, `type Session` from `src/ui/api.ts` (Task 4).

- [ ] **Step 1: Rewrite `YourActivityPage.tsx`**

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
    <div className="h-full flex flex-col px-6 py-4 gap-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Your Activity</h1>
          <p className="text-xs text-neutral-400">
            Recent meetings and notes captured by the app.
          </p>
        </div>
      </div>

      <div className="mt flex-1 rounded-2xl bg-neutral-900/80 border border-neutral-800 overflow-y-auto">
        {error && (
          <div className="h-full flex items-center justify-center text-sm text-red-400">
            Failed to load activity: {error}
          </div>
        )}

        {!error && sessions === null && (
          <div className="h-full flex items-center justify-center text-sm text-neutral-400">
            Loading...
          </div>
        )}

        {!error && sessions !== null && sessions.length === 0 && (
          <div className="h-full flex items-center justify-center text-sm text-neutral-400">
            No meetings recorded yet.
          </div>
        )}

        {!error && sessions !== null && sessions.length > 0 && !selected && (
          <ul className="divide-y divide-neutral-800">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelectedId(s.id)}
                  className="w-full text-left px-4 py-3 hover:bg-neutral-800/60 flex items-center justify-between"
                >
                  <span className="text-sm text-white">{s.title}</span>
                  <span className="text-xs text-neutral-400">
                    {formatRelativeTime(s.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!error && selected && (
          <div className="h-full flex flex-col">
            <div className="px-4 py-2 border-b border-neutral-800 flex items-center justify-between">
              <span className="text-sm text-white">{selected.title}</span>
              <button
                onClick={() => setSelectedId(null)}
                className="text-xs text-neutral-400 hover:text-white"
              >
                Back
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto px-4 py-3 text-xs text-neutral-200 whitespace-pre-wrap">
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

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/YourActivityPage.tsx
git commit -m "feat: wire YourActivityPage to GET /sessions with list/detail view"
```

---

## Task 6: Wire `YourActivity` dashboard card to real data

**Files:**
- Modify: `src/ui/components/YourActivity.tsx` (full rewrite of the component body)

**Interfaces:**
- Consumes: `getSessions`, `type Session` from `src/ui/api.ts` (Task 4).

- [ ] **Step 1: Rewrite `YourActivity.tsx`**

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
    <div className="p-4 w-50 bg-zinc-800/55 rounded-xl backdrop-blur-md backdrop-saturate-150 border border-white/12 shadow-[0_8px_32px_rgba(0,0,0,0.25)] text-white">
      <h2 className="text-lg font-semibold mb-2">Your Activity</h2>
      <div className="text-xs">
        {sessions === null && <p>Loading...</p>}
        {sessions !== null && (
          <>
            <p>
              • {count} meeting{count === 1 ? "" : "s"} recorded
            </p>
            {mostRecentTitle && <p>• Latest: {mostRecentTitle}</p>}
          </>
        )}
      </div>
    </div>
  );
};

export default YourActivity;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/YourActivity.tsx
git commit -m "feat: wire dashboard YourActivity card to GET /sessions"
```

---

## Task 7: Status-dot flash on `/process` result in `RailApp`

**Files:**
- Modify: `src/rail/RailApp.tsx`

**Interfaces:**
- Consumes: existing `status` from `useThreeTrackSegments()` (unchanged).
- Produces: local `resultFlash: "success" | "error" | null` state driving the status dot's color.

- [ ] **Step 1: Add flash state and update it around the `/process` call**

In `src/rail/RailApp.tsx`, add state near the top of the component (after the `useThreeTrackSegments()` line):

```tsx
import { useEffect, useState } from "react";
```

Add this import at the top of the file alongside the existing imports, then inside `RailApp`:

```tsx
const [resultFlash, setResultFlash] = useState<"success" | "error" | null>(null);

useEffect(() => {
  if (resultFlash === null) return;
  const timer = setTimeout(() => setResultFlash(null), 2000);
  return () => clearTimeout(timer);
}, [resultFlash]);
```

In `handleRecordClick`, wrap the fetch/response handling to set `resultFlash`. Replace the body from `const resp = await fetch(...)` through the end of the `else if` block with:

```tsx
            try {
              const resp = await fetch(`${BACKEND_URL}/process`, {
                method: "POST",
                body: formData,
              });

              if (!resp.ok) {
                const text = await resp.text();
                throw new Error(`Backend error ${resp.status}: ${text}`);
              }

              const data = (await resp.json()) as ProcessResponse;
              console.log("[Rail] backend /process result:", data);
              setResultFlash("success");
            } catch (err) {
              console.error("/process failed", err);
              setResultFlash("error");
            }
```

(This nests inside the existing outer `try { ... } catch (err) { console.error("record/stop error", err); }` — the outer catch still handles failures in `record()`/`stop()` itself; the new inner `try/catch` handles the `/process` call specifically so it can distinguish success/failure for the flash.)

- [ ] **Step 2: Use `resultFlash` to color the status dot**

Find the status dot line near the end of the JSX:

```tsx
<span className="mt-auto h-2.5 w-2.5 rounded-full bg-gray-400 border border-black" />
```

Replace it with:

```tsx
<span
  className={
    "mt-auto h-2.5 w-2.5 rounded-full border border-black transition-colors " +
    (resultFlash === "success"
      ? "bg-emerald-500"
      : resultFlash === "error"
      ? "bg-red-500"
      : "bg-gray-400")
  }
/>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/rail/RailApp.tsx
git commit -m "feat: flash rail status dot on /process success or failure"
```

---

## Task 8: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the backend**

Run: `cd backend && uvicorn app.server:app --reload --port 8000`
Expected: server starts, `GET http://localhost:8000/health` returns `{"ok": true}`.

- [ ] **Step 2: Start the frontend + Electron app**

Run: `npm run dev:react` (in one terminal) and `npm run dev:electron` (in another).
Expected: main window opens showing the dashboard with a "Your Activity" card reading "0 meetings recorded" and "No meetings recorded yet." on the full activity page.

- [ ] **Step 3: Record a short clip via the rail**

Toggle the rail open from the title bar pill button, click Record, wait a few seconds, click Record again to stop.
Expected: the rail's status dot flashes green briefly after the upload completes (or red if the backend call fails — check the backend terminal for errors).

- [ ] **Step 4: Confirm it shows up in Your Activity**

Navigate to the Your Activity tab (or reopen the dashboard).
Expected: the dashboard card now shows "1 meeting recorded" and a "Latest: ..." title; the full Your Activity page lists the new entry with a relative timestamp ("just now"); clicking it shows the notes text.

- [ ] **Step 5: Confirm `GET /sessions` reflects it directly**

Run: `curl http://localhost:8000/sessions` (or open in browser)
Expected: JSON array with one object containing `id`, `created_at`, `title`, `notes`, `video_path`.

No commit for this task — it's verification only. If any step fails, file it as a follow-up rather than silently patching outside this plan's scope.

---

## Self-Review Notes

- **Spec coverage:** JSON index persistence (Task 1, 3), `txt_path`/duplicate-`options` bug fixes (Task 2), `GET /sessions` (Task 3), frontend list/detail view with loading/empty/error states (Task 5), dashboard card summary (Task 6), rail status-dot feedback (Task 7), manual verification (Task 8) — all spec sections have a corresponding task.
- **Placeholder scan:** no TBD/TODO markers; all steps include full code.
- **Type consistency:** `Session` type in `api.ts` (Task 4) matches the record shape produced by `server.py` (Task 3) and is reused verbatim in `YourActivityPage.tsx` (Task 5) and `YourActivity.tsx` (Task 6). `extract_title`/`load_sessions`/`append_session` signatures from Task 1 are used identically in Task 3.
