# Published installers are immutable

Once a version's update manifest (`latest.yml` / `latest-mac.yml`) is live, that version is final: its installers are never re-uploaded. If something is wrong with a live release, we fix it and ship the next patch version. `npm run release` no longer has a `--force` flag to republish an existing version.

## Context

Updates are served from an R2 bucket behind Cloudflare's CDN. Installers are cached at the edge for hours, while manifests are cached only briefly. Rebuilds are not byte-reproducible. So re-uploading an installer under the same name after a rebuild leaves edge locations serving the old installer next to a new manifest. That manifest's sha512 describes the new file, so electron-updater rejects every update, and Windows clients update automatically. The release script's own verification checks only sizes, at the origin, so it would report success.

## Decision

Treat every published version as final. Keep re-runs safe instead of allowing overwrites:

- The release script uploads the manifest last. A failed upload never makes the version live, so simply re-running the release is safe. Installer objects from the failed attempt are unreferenced, and overwriting them is harmless.
- After the manifest is live, a problem is fixed by bumping the patch version and releasing that.

## Considered options

- **Allow same-name re-uploads, then purge the CDN cache.** Rejected. It relies on a manual purge being remembered in the middle of an incident, and the release would wrongly report success if the purge is skipped.
- **Short `Cache-Control` on installers.** Rejected. It weakens caching for every download to protect a rare repair, and it still leaves a window where a stale installer is served against a new manifest.

## Consequences

- Patch versions become slightly more frequent: a broken release costs a version bump instead of a re-upload.
- The CDN needs no special configuration, and no repair step can be forgotten.
