# DeskRecap

A local-first desktop app for recording meetings, transcribing them, summarizing
the transcript, and chatting with an LLM about the notes afterward — all
without your audio or text ever leaving your machine.

## What it does

The core flow is **record → transcribe → summarize → chat**:

1. Record a meeting (mic and/or screen audio) from the app.
2. The recording is transcribed locally with Whisper.
3. The transcript is summarized (and can be chatted about) using the
   built-in local model (a bundled llama.cpp server with a one-time model
   download) — or, optionally, Ollama or any OpenAI-compatible endpoint.
4. Sessions, transcripts, and summaries are kept in a local session store you
   can browse, rename, export, or trash later.

## Architecture

- **Frontend:** Electron + React + TypeScript (Vite), in `src/ui` and
  `src/electron`.
- **Backend:** a Python/FastAPI server in `backend/app`, responsible for
  recording/session storage, transcription (Whisper via `ffmpeg`/`ffprobe`),
  and summarize/chat requests to the selected AI provider.
- **AI provider:** the default is the **built-in** local model — a bundled
  llama.cpp `llama-server` (vendored by `npm run fetch:llama`, managed by
  `backend/app/builtin_llm.py`) serving Gemma 3 4B, downloaded once (~2.5 GB)
  on the user's explicit click in the first-run gate. No Ollama install is
  needed. [Ollama](https://ollama.com) and any OpenAI-compatible endpoint
  remain available as advanced options in Settings → AI model.

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

The backend binds to `127.0.0.1` only (see `main()` in
`backend/app/server.py`), but that alone doesn't make it private: every web
page open in the user's browser can also send requests to `127.0.0.1`. A
multipart upload to `/process`, for example, is sent cross-origin without any
CORS preflight. So the API requires a **per-launch token**:

- On every launch Electron generates a random 256-bit token
  (`generateBackendToken` in `src/electron/backend.js`). It passes the token
  to the backend in the `DESKRECAP_API_TOKEN` env var, and to its own two
  windows through the preload bridge (`window.BACKEND_CONFIG.token`). The
  token is never written to disk.
- Every request, `/health` included, must send it as the
  `X-DeskRecap-Token` header, or it gets `401`. `src/ui/api.ts`'s
  `backendFetch` adds the header for the renderers. Electron's own
  health/watchdog/quit-guard probes send it too.
- A request with an `Origin` header that isn't in `ALLOWED_ORIGINS` gets
  `403`, even when it has a valid token.
- `ALLOWED_ORIGINS` is empty by default. The packaged app loads its pages
  from `file://`, and Electron sends no `Origin` header (and applies no CORS)
  for those requests, so it needs no CORS allowance. `"null"` is never
  honoured, because sandboxed iframes on any site send `Origin: null`.
- Saved secrets (the HuggingFace token and the custom-provider API key) are
  write-only. `GET`/`PATCH /settings` return only `huggingface_token_set` /
  `custom_api_key_set` booleans, never the values.

Other processes running as the same OS user are out of scope: they can read
the backend's environment or the settings file directly. **The app should
never be exposed to a network** (don't change the bind host to `0.0.0.0`,
port-forward it, or put it behind a reverse proxy).

## Getting started (development)

First-time setup (once):

```
npm install
npm run setup:backend
```

`npm run setup:backend` creates a `.venv` at the project root and installs
**`requirements.lock`** into it: every Python package the app, the tests and
the build need -- transitive dependencies included -- pinned to exact,
hash-checked versions for both macOS and Windows. CI and the release build
install the same lock, so a fresh build environment can never pick up a
different version than the one tested (a new transitive release once broke
every transcription exactly that way). Re-run setup any time the lock
changes.

To change a dependency, edit the relevant `requirements*.txt`, then run
`npm run lock:python` to regenerate the lock (it never upgrades anything you
didn't ask for; `npm run lock:python -- --upgrade-package <name>` upgrades
one package deliberately). CI fails if the lock is out of date.

| File | What it's for |
| --- | --- |
| `requirements.lock` | Generated (`npm run lock:python`): everything below, fully pinned with hashes. What setup, CI and the build install. |
| `requirements.txt` | What the backend needs at runtime (and what PyInstaller freezes). |
| `requirements-dev.txt` | `requirements.txt` + pytest, ruff and uv (which generates the lock). |
| `requirements-build.txt` | PyInstaller (+ hooks), for `npm run build:backend`. |
| `requirements-diarization.txt` | Optional torch + pyannote.audio 4.x for advanced diarization. The default speaker identification needs none of this: it runs on the bundled ONNX embedding model (`npm run fetch:speaker-model`, `backend/app/speaker_id.py`) with persistent voice profiles — name a speaker once and their voice is recognized in later meetings. |

Backend tests and lint:

```
cd backend && ../.venv/bin/python -m pytest -q
.venv/bin/ruff check .
```

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

Run this way, without Electron, there is no `DESKRECAP_API_TOKEN`. The
backend then prints a warning at startup together with a random token it
generated for that run, and still rejects any request that doesn't send it.
To use a fixed token instead, set it yourself:

```
cd backend && DESKRECAP_API_TOKEN=dev-token python -m app.server
curl -H 'X-DeskRecap-Token: dev-token' http://127.0.0.1:8000/health
```

To point the plain-browser Vite dev server (`npm run dev:react`) at that
backend, allow its origin on the backend and give the renderer the same
token:

```
cd backend && DESKRECAP_API_TOKEN=dev-token ALLOWED_ORIGINS=http://localhost:5173 python -m app.server
VITE_DESKRECAP_API_TOKEN=dev-token npm run dev:react
```

## Building an installer

```
npm install
npm run setup:backend
npm run dist
```

This builds for the machine you run it on, into `release/`: on Windows an NSIS
installer (`DeskRecap Setup X.Y.Z.exe`), on macOS a `.dmg` and a `.zip`. It
never uploads anything -- publishing is `npm run release` (see
[Publishing a release](#publishing-a-release)). The package bundles the Python backend (frozen with PyInstaller)
and ffmpeg/ffprobe, so **end users installing the packaged app do not need
Python or ffmpeg installed separately.**

End users need no external installs at all: the AI chat/summarize features
use the bundled llama.cpp server by default, downloading its model once on
first use. Installing [Ollama](https://ollama.com) is only needed if the
user switches the provider to Ollama in Settings.

**System requirements:** macOS 14 or later (the build declares it, so older
macOS refuses to open the app instead of failing at first run), or Windows
10/11 x64. On Windows, the Microsoft C++ runtime `llama-server` needs
(`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`) is bundled next
to it, so clean installs without the Visual C++ Redistributable work too:
the `beforePack` hook (`scripts/check-extra-resources.mjs`) copies the newest
copy found on the build machine (its System32, or the frozen backend) and
fails the build if any is missing.

**Third-party licenses:** `THIRD_PARTY_NOTICES.md` (FFmpeg under GPLv3 with
its source offer, llama.cpp, the speaker model, bundled Python packages)
ships inside the app and opens from Settings → About. Update it when a
bundled component or its license changes.

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
  with that arch and the pinned archive's checksum, so a `vendor/` directory
  copied from another machine -- or fetched before a repin -- is re-fetched
  rather than silently packaged), and likewise the llama.cpp server binary
  (`npm run fetch:llama`, same pinned-checksum + `.arch` stamp scheme into
  `vendor/llama`).

`build.mac` therefore sets no explicit `arch`, which leaves electron-builder on
its default: the host architecture. Don't pin one back in — hardcoding `arm64`
previously meant an Intel machine produced an arm64 bundle wrapping an x86_64
backend and arm64 ffmpeg, which could not run anywhere.

The release build uses Python 3.12 (`.python-version`; CI uses the same).
Anything older than 3.9 can't work at all (`requirements.txt` needs 3.9+).
macOS's own `/usr/bin/python3` is 3.8 and answers to both `python` and
`python3`; `npm run setup:backend` checks the version and refuses it rather
than building a venv that every `pip install` then fails against. Install a
newer one (`brew install python@3.12`) if it does.

### macOS: ad-hoc signing (no Apple Developer ID)

DeskRecap's Mac builds are **ad-hoc signed**, and that is permanent: there is
no paid Apple Developer account, so there is no Developer ID certificate and
no notarization. `build.mac.identity` is `"-"`, which tells electron-builder
to ad-hoc sign every binary in the bundle (the app, Electron's helpers, the
PyInstaller backend and ffmpeg). Don't remove it: a completely unsigned
download shows "DeskRecap is damaged and can't be opened", with no way
around it for most users; an ad-hoc-signed one shows "Apple could not
verify…", which the user can get past once.

`scripts/notarize.mjs` (the `afterSign` hook) skips every ad-hoc build and
logs why -- Apple can only notarize Developer ID builds, so trying would
just fail the release -- even if `APPLE_API_*` variables happen to be set.

What ad-hoc builds mean for Mac users:

- **First launch needs "Open Anyway".** Double-clicking the downloaded app
  shows "Apple could not verify 'DeskRecap' is free of malware…". Click
  **Done**, then open **System Settings → Privacy & Security**, scroll to the
  message about DeskRecap and click **Open Anyway**, then confirm with
  **Open**. (On macOS 14 and earlier, right-click the app → **Open** also
  works.) This is needed once per installed version.
- **No in-app auto-update on macOS.** Squirrel.Mac, which installs updates on
  macOS, only accepts updates signed with a real Developer ID. So on macOS the
  app only *checks*: Settings → About shows "Version X is available —
  download it from deskrecap.com", and the user downloads and installs the
  new version like the first one. Nothing is downloaded in the background.
  (Windows updates still download and install automatically.)
- **macOS may ask for microphone (and screen recording) permission again**
  after a new version is installed: without a stable Developer ID signature,
  macOS can't always tell the new build is the same app.

**Entitlements** (`build/entitlements.mac.plist`, used for both
`entitlements` and `entitlementsInherit`) are the minimum that was verified
to launch and run the backend:

| Entitlement | Why |
| --- | --- |
| `cs.disable-library-validation` | With hardened runtime, library validation rejects loading any code whose Team ID differs from the process's -- and ad-hoc signatures have none, so without it the app dies at launch with *"Library not loaded: …Electron Framework… different Team IDs"*. The backend's Python libraries need it for the same reason. |
| `cs.allow-jit` | V8 in the main process and the renderer helpers; without it hardened-runtime Electron crashes on launch ("Failed to reserve virtual memory for CodeRange"). |
| `device.audio-input` | Microphone access under hardened runtime, including in Chromium's audio helper process. |

`cs.allow-unsigned-executable-memory` was removed: it's a looser superset of
`allow-jit` that Electron 39 doesn't need (verified by building and running
the app). There's no separate, smaller inherit plist, because every
entitlement above is needed by at least one of Electron's own helpers, and
electron-builder can't give the backend and ffmpeg a different set without a
custom signing step. The microphone prompt text is
`build.mac.extendInfo.NSMicrophoneUsageDescription`.

## Publishing a release

Release artifacts are hosted on a Cloudflare R2 bucket,
`meeting-note-taker-updates`, served at `https://updates.deskrecap.com`. Each
platform has its own manifest there, which both the in-app updater and the
website's download button read to find the current installer:

| Platform | Manifest | Installers |
| --- | --- | --- |
| Windows | `latest.yml` | `DeskRecap Setup X.Y.Z.exe` |
| macOS | `latest-mac.yml` | `DeskRecap-X.Y.Z-arm64.dmg` / `-arm64-mac.zip` (Apple Silicon); `DeskRecap-X.Y.Z.dmg` / `-mac.zip` (Intel, no arch in the name) |

There are two separate pieces of config, serving two different purposes --
both must stay correct:

- **`build.publish` in `package.json`** -- the R2 bucket's S3-compatible API
  (`provider: "s3"` with R2's endpoint). Only used at publish time to know
  where to *upload*. It needs write credentials and is never read by the
  running app.
- **The feed URL the app reads** -- `DEFAULT_FEED_URL` in
  `src/electron/updateFeed.js` (`https://updates.deskrecap.com`, overridable
  with `UPDATE_FEED_URL`). `armAutoUpdate` sets it explicitly, overriding
  whatever electron-builder baked in from `build.publish`, so the app only
  ever does plain HTTPS GETs against the public URL. `npm run release` reads
  the same value to check what's already published. If the bucket's public
  URL ever changes, change it there.

### Steps

1. **Bump `"version"` in `package.json`** (e.g. `1.0.0` → `1.0.1`).
   Installed apps only update to a strictly newer version, so re-publishing
   the same version reaches nobody -- which is why the script refuses it.
2. **Run the release** on the machine for the platform (and, on macOS, the
   architecture) you're shipping, with the R2 write credentials in the
   environment -- never in `package.json` or a committed file. (Windows
   can also be released from CI: see **Windows from CI** below.)

   Keep the keys in a file rather than typing them into the command line
   (where they end up in your shell history). `.env*` files are gitignored;
   create `.env.release` in the repo root with:

   ```bash
   AWS_ACCESS_KEY_ID=<r2 access key id>
   AWS_SECRET_ACCESS_KEY=<r2 secret access key>
   ```

   **macOS / Linux** (bash or zsh):

   ```bash
   npm run release -- --check      # optional: just the checks, nothing built or uploaded
   set -a; source .env.release; set +a
   npm run release
   ```

   **Windows** (PowerShell):

   ```powershell
   npm run release -- --check
   Get-Content .env.release | ForEach-Object {
     if ($_ -match '^\s*([^#=]+)=(.*)$') { Set-Item -Path "Env:$($matches[1].Trim())" -Value $matches[2].Trim() }
   }
   npm run release
   ```

   (Or, for a one-off: `$env:AWS_ACCESS_KEY_ID = "..."; $env:AWS_SECRET_ACCESS_KEY = "..."` -- note
   PowerShell also keeps a history, in `(Get-PSReadLineOption).HistorySavePath`.)

   `npm run release` (`scripts/release.mjs`):
   - **refuses** prerelease versions (`1.1.0-beta.1`): electron-builder would
     publish them to `beta*.yml`, which nothing reads;
   - fetches the published manifest for this platform and **refuses** if
     `package.json`'s version is already published or older, or if the
     manifest can't be read at all. There is no override: published
     versions are final ([ADR 0001](docs/adr/0001-immutable-published-installers.md)),
     so a fix to a live release ships as the next patch version;
   - on macOS, **refuses** if the published `latest-mac.yml` lists another
     architecture's files (see below; `--force-arch` overrides);
   - refuses if the R2 credentials aren't set, or if `UPDATE_FEED_URL` is
     set (it only redirects the app -- releases always go to production);
   - then runs `npm run fetch:vendor` (ffmpeg, llama-server and the
     speaker-ID model), `npm run build`, `npm run build:backend` and
     `electron-builder --publish never` (build only, no upload; its
     `beforePack` hook, `scripts/check-extra-resources.mjs`, refuses to
     package if any vendored directory is missing or empty);
   - checks the published manifest again, in case the same version went out
     while it was building;
   - uploads the installers and their `.blockmap`s with
     `scripts/upload-r2.mjs`, in 10 MB parts that are each retried on their
     own, and the manifest (`latest-mac.yml` / `latest.yml`) **last**, only
     after every other file succeeded;
   - finally re-reads the published manifest and checks every file it
     lists is really there at full size.

   Flags work with or without the `--`: `npm run release --check` (which
   npm turns into an environment variable rather than passing on) is
   honoured the same as `npm run release -- --check`.
3. **Tag it** (the script prints the command):

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The R2 manifest is what apps update against, not the tag -- but the tag
   is what turns a bug report's "which version are you on" into something you
   can check out and debug.

For a release on both platforms, run it once for Windows (on a Windows
machine or from CI, below) and once on the Mac, with the same version.

**Windows from CI.** The **Release (Windows)** workflow
(`.github/workflows/release-windows.yml`) runs this same `npm run release`
on a fresh `windows-latest` runner, so a Windows release doesn't need a
Windows machine. It only starts by hand: from the **Actions** tab
(**Release (Windows)** → **Run workflow**), or with
`gh workflow run release-windows.yml --ref <branch-or-tag>` (without
`--ref`, the default branch). It builds the tip of that branch or tag, and
refuses anything but `master` or a `v*` tag, so push the version bump
first and tag afterwards (step 3; the script prints the exact commit to
tag). Runs are queued one at a time, so don't also run a local Windows
release of the same version. It needs two repository secrets (Settings →
Secrets and variables → Actions), `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` -- the same R2 write credentials as `.env.release`.
Its **check** input is `--check`. A failed run keeps the installer it built
as a workflow artifact for 14 days, for diagnosis.

**Big uploads on a flaky network.** The installers are ~240 MB, and
electron-builder's own publisher sends each in a single request, which
repeatedly failed on an unreliable connection ("SSL alert bad record mac",
EPIPE). That's why the release script builds with `--publish never` and
uploads itself, in 10 MB parts with per-part retries. The installers must be
completely uploaded *before* the manifest: a manifest pointing at a missing
or truncated installer breaks both the updater and the website's download
button. The script guarantees that order and stops before the manifest if
any file fails, so users keep getting the previous version -- the version
never went live, so just fix the network and run `npm run release` again.
Once a manifest *is* live, never re-upload its installers: a rebuild
produces different bytes, and the CDN in front of the bucket keeps serving
the old installer for hours against the new manifest's checksum, so every
update fails. Ship the next patch version instead
([ADR 0001](docs/adr/0001-immutable-published-installers.md)).

**One Mac architecture per manifest.** `latest-mac.yml` only lists the files
of the architecture that published it, so publishing from an Apple Silicon
Mac replaces any Intel entries (and vice versa) -- Intel users would stop
seeing updates and the website would lose their download. Today only arm64
is published. The release script refuses a Mac publish that would drop
another architecture. To ship both, the two `latest-mac.yml` files have to
be merged by hand (both `files:` lists in one manifest) and uploaded after
both sets of installers; the script doesn't do that.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev:react` | Run the Vite dev server for the React frontend alone. |
| `npm run dev:electron` | Launch the Electron app (auto-starts the backend). |
| `npm run build` | Type-check and build the frontend. |
| `npm run lint` | Run ESLint (TypeScript/React, and the Node `.js`/`.mjs` in `src/electron` and `scripts`). |
| `npm run test:main` | Run Electron main-process and build/release-script tests (`src/electron/*.test.js`, `scripts/*.test.mjs`). |
| `npm run test:ui` | Run frontend tests (Vitest). |
| `npm run setup:backend` | Create/refresh the Python `.venv` from `requirements.lock` (runtime, test/lint and build tools, all pinned with hashes). |
| `npm run lock:python` | Regenerate `requirements.lock` after editing a `requirements*.txt` (`-- --check` verifies it's current, as CI does). |
| `npm run fetch:ffmpeg` | Download the ffmpeg/ffprobe binaries used by the backend. |
| `npm run fetch:llama` | Download the llama.cpp `llama-server` binary used by the built-in AI provider. |
| `npm run fetch:speaker-model` | Download the ONNX speaker-embedding model used for speaker identification (`backend/app/speaker_id.py`). |
| `npm run fetch:vendor` | All three fetches above: everything `build.extraResources` packages from `vendor/`. |
| `npm run build:backend` | Freeze the Python backend with PyInstaller for packaging. |
| `npm run dist` | Full build + package for this platform into `release/` (`fetch:vendor`, `build`, `build:backend`, `electron-builder --publish never`). Never uploads. |
| `npm run release` | Check, build and publish a release to the update bucket (see [Publishing a release](#publishing-a-release)). `-- --check` only runs the checks. |
