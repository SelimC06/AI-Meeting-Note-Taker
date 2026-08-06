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

## Security model

The backend has no authentication on its API. This is intentional: the
server binds to `127.0.0.1` only (see `main()` in `backend/app/server.py`)
and is designed to run entirely locally for a single user, the same way most
local dev servers and tools like VS Code's local server work. Because there's
no token check, any other process running on the same machine could in
principle reach `127.0.0.1:8000` and read, export, or delete session data, or
trigger recording/chat requests. This is an accepted tradeoff for a
local-only tool — **the app should never be exposed to a network** (don't
change the bind host to `0.0.0.0`, port-forward it, or put it behind a
reverse proxy without adding real authentication first).

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

### Publishing updates

The app checks `https://updates.example.invalid/meeting-note-taker` for new
versions on startup (see `src/electron/updater.js`) — **this is a
placeholder and must be replaced** with a real public URL (e.g. a
Cloudflare R2 or S3 bucket you control) before shipping a release.

There are two separate things that both need to point at that real host,
and both must be correct — editing only one is not sufficient:

- **`build.publish.url` in `package.json`** — where
  `electron-builder --publish always` uploads the installer and the
  `latest.yml` manifest.
- **The runtime feed URL the app actually checks** — controlled by
  `getUpdateFeedUrl()` in `src/electron/updater.js` (its `DEFAULT_FEED_URL`
  constant, or the `UPDATE_FEED_URL` environment variable at runtime). This
  is *not* read from `package.json`. `armAutoUpdate` calls
  `updater.setFeedURL({ provider: 'generic', url: getUpdateFeedUrl() })`
  unconditionally, which overrides whatever `app-update.yml`
  electron-builder baked in from `build.publish.url`.

Editing only `build.publish.url` and cutting a release would ship a build
that still checks the placeholder host at runtime. Before shipping, make
sure both `DEFAULT_FEED_URL` in `updater.js` and `build.publish.url` in
`package.json` point at the same real host (or set `UPDATE_FEED_URL` in the
packaged app's environment to override the runtime value).

Publishing a new version is a manual step, not part of `npm run dist`:

```bash
electron-builder --publish always
```

This uploads the installer and a `latest.yml` manifest to the configured
`publish.url`. Bump `"version"` in `package.json` first — electron-updater
compares semver against `latest.yml` to decide whether an update exists.

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
