# Meeting Note Taker

A local-first desktop app for recording meetings, transcribing them, summarizing
the transcript, and chatting with an LLM about the notes afterward — all
without your audio or text ever leaving your machine.

## What it does

The core flow is **record → transcribe → summarize → chat**:

1. Record a meeting (mic and/or screen audio) from the app.
2. The recording is transcribed locally with Whisper.
3. The transcript is summarized (and can be chatted about) using a local
   Ollama model.
4. Sessions, transcripts, and summaries are kept in a local session store you
   can browse, rename, export, or trash later.

## Architecture

- **Frontend:** Electron + React + TypeScript (Vite), in `src/ui` and
  `src/electron`.
- **Backend:** a Python/FastAPI server in `backend/app`, responsible for
  recording/session storage, transcription (Whisper via `ffmpeg`/`ffprobe`),
  and summarize/chat requests to Ollama.
- **External dependency:** [Ollama](https://ollama.com) — must be installed
  locally with a chat model pulled for the summarize/chat features to work.
  Everything else (recording, transcription, storage) works without it.

In the packaged app, Electron starts the Python backend automatically on
launch (waiting for it to become healthy before showing the window) and stops
it when the app quits. You don't need to run the backend manually in a
separate terminal unless you're debugging it in isolation.

## Data & privacy

Recordings, transcripts, and summaries are stored only on this machine —
nothing is uploaded anywhere. By default they live under the app's local
user-data directory, but the storage location is configurable from Settings.
Sessions moved to trash are permanently deleted after 30 days
(`purge_expired_trash` in `backend/app/sessions_store.py`). The same summary
is shown in-app under Settings → Privacy.

## Getting started (development)

First-time setup (once):

```
npm install
npm run setup:backend
```

`npm run setup:backend` creates a `.venv` at the project root and installs
`requirements.txt` into it. Re-run it any time `requirements.txt` changes.

Then:

```
npm run build
npm run dev:electron
```

For debugging the backend in isolation, you can still run it manually with:

```
cd backend && python -m app.server
```

This runs the `if __name__ == "__main__":` guard in `backend/app/server.py`,
which calls `main()` and binds the server to `127.0.0.1` only (port `8000` by
default, override with the `PORT` env var). Prefer this over hand-typing
`uvicorn app.server:app --reload --port 8000`, since that command does not
enforce the localhost-only bind.

## Building an installer (Windows)

```
npm install
npm run setup:backend
npm run dist
```

This produces a Windows installer under `release/`. The installer bundles the
Python backend (frozen with PyInstaller) and ffmpeg/ffprobe, so **end users
installing the packaged app do not need Python or ffmpeg installed
separately.**

The one remaining external dependency for end users is
[Ollama](https://ollama.com) — install it and pull a chat model before using
the chat/summarize features.

`npm run setup:backend` and the `.venv` it creates are only needed for
*building* the installer (or running the backend directly in dev mode) — they
are not needed by someone just installing and running the packaged app.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev:react` | Run the Vite dev server for the React frontend alone. |
| `npm run dev:electron` | Launch the Electron app (auto-starts the backend). |
| `npm run build` | Type-check and build the frontend. |
| `npm run lint` | Run ESLint. |
| `npm run test:main` | Run Electron main-process tests (`src/electron/*.test.js`). |
| `npm run test:ui` | Run frontend tests (Vitest). |
| `npm run setup:backend` | Create/refresh the Python `.venv` from `requirements.txt`. |
| `npm run fetch:ffmpeg` | Download the ffmpeg/ffprobe binaries used by the backend. |
| `npm run build:backend` | Freeze the Python backend with PyInstaller for packaging. |
| `npm run dist` | Full build + package into a Windows installer (`build`, `build:backend`, `fetch:ffmpeg`, `electron-builder`). |
