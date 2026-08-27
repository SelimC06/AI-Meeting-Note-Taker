# DeskRecap

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

## Building an installer

```
npm install
npm run setup:backend
npm run dist
```

On Windows this produces an NSIS installer under `release/`; on macOS, a `.dmg`
and a `.zip`. The package bundles the Python backend (frozen with PyInstaller)
and ffmpeg/ffprobe, so **end users installing the packaged app do not need
Python or ffmpeg installed separately.**

The one remaining external dependency for end users is
[Ollama](https://ollama.com) — install it and pull a chat model before using
the chat/summarize features.

`npm run setup:backend` and the `.venv` it creates are only needed for
*building* the installer (or running the backend directly in dev mode) — they
are not needed by someone just installing and running the packaged app.

### macOS: build on the architecture you're shipping to

**A macOS package is only valid for the architecture of the machine that built
it** — build the arm64 release on Apple Silicon and the x64 release on Intel.
Two of the three bundled pieces are host-native and cannot cross-compile:

- the backend, frozen by PyInstaller from the local `.venv` (`npm run
  build:backend`), and
- ffmpeg/ffprobe, vendored as native static builds (`npm run fetch:ffmpeg`,
  which picks its download by `process.arch` and stamps `vendor/ffmpeg/.arch`
  so a `vendor/` directory copied from another machine is re-fetched rather
  than silently packaged).

`build.mac` therefore sets no explicit `arch`, which leaves electron-builder on
its default: the host architecture. Don't pin one back in — hardcoding `arm64`
previously meant an Intel machine produced an arm64 bundle wrapping an x86_64
backend and arm64 ffmpeg, which could not run anywhere.

The Python used for the build must be 3.9+ (`requirements.txt` needs it).
macOS's own `/usr/bin/python3` is 3.8 and answers to both `python` and
`python3`; `npm run setup:backend` checks the version and refuses it rather
than building a venv that every `pip install` then fails against. Install a
newer one (`brew install python@3.12`) if it does.

### macOS: signing and notarization

Local builds work with no Apple credentials at all — `scripts/notarize.mjs`
logs that it's skipping and returns, leaving an unsigned build that runs fine
on the machine that produced it.

To ship to *other* Macs you need both halves, because `build.mac.hardenedRuntime`
is `true` and Gatekeeper rejects a hardened app that isn't notarized:

1. **A Developer ID Application certificate** in the login keychain.
   electron-builder finds it automatically; without it the app is only
   ad-hoc signed.
2. **An App Store Connect API key**, passed to `afterSign` through these
   environment variables (all three required — if any is missing,
   notarization is skipped with a message naming which):

   | Variable | Value |
   | --- | --- |
   | `APPLE_API_KEY` | path to the `AuthKey_XXXXXXXXXX.p8` file |
   | `APPLE_API_KEY_ID` | the key ID (the `XXXXXXXXXX` in the filename) |
   | `APPLE_API_ISSUER` | the issuer UUID from App Store Connect |

   Treat the `.p8` as a secret: never commit it or bake it into
   `package.json`.

Entitlements live in `build/entitlements.mac.plist` and are applied to both the
app and its inherited helper processes. The microphone usage string end users
see at the permission prompt is `build.mac.extendInfo.NSMicrophoneUsageDescription`.

### Publishing updates

Release artifacts (the installer + `latest.yml` manifest) are hosted on a
Cloudflare R2 bucket, `meeting-note-taker-updates`. There are two separate
pieces of config, serving two different purposes — both must stay correct:

- **`build.publish` in `package.json`** — the R2 bucket's S3-compatible API
  (`provider: "s3"` with R2's endpoint). This is only used at *publish
  time*, by `electron-builder --publish always`, to know where to *upload*
  a new release. It requires write credentials (see below) and is never
  read by the running app.
- **The runtime feed URL the app actually checks** — `DEFAULT_FEED_URL` in
  `src/electron/updater.js`, currently a custom domain in front of the
  bucket (`https://updates.deskrecap.com`), overridable via
  the `UPDATE_FEED_URL` environment variable. `armAutoUpdate` calls
  `updater.setFeedURL({ provider: 'generic', url: getUpdateFeedUrl() })`
  unconditionally, which overrides whatever `app-update.yml`
  electron-builder baked in from `build.publish` — so the app always does a
  plain, unauthenticated HTTPS GET against the public URL, never the S3 API
  endpoint.

If the bucket is ever recreated or its public URL changes, update
`DEFAULT_FEED_URL` in `updater.js` to match — editing `build.publish` alone
is not sufficient, since that only controls where uploads go, not what the
app reads.

Publishing a new version is a manual step, not part of `npm run dist`.
`electron-builder`'s S3 publisher reads write credentials from the
standard AWS SDK environment variables (never store these in
`package.json` or commit them):

```bash
AWS_ACCESS_KEY_ID=<r2 access key id> AWS_SECRET_ACCESS_KEY=<r2 secret access key> electron-builder --publish always
```

This uploads the installer and a `latest.yml` manifest to the R2 bucket.
Bump `"version"` in `package.json` first — electron-updater compares
semver against `latest.yml` to decide whether an update exists.

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
