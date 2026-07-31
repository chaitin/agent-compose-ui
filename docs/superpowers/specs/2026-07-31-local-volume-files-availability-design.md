# Local Volume Files Availability Design

## Scope

Fix local-development volume file browsing in `agent-compose-ui` without changing the
`agent-compose` daemon. The change covers the UI gateway's local launch configuration
and the Svelte browser's unavailable/not-found states.

## Current Behavior and Root Cause

The local development environment runs the daemon, UI gateway, script service, and
Vite server as separate host processes. The UI gateway starts without
`LOCAL_VOLUME_ROOT`, so it deliberately leaves the volume resolver disabled. Every
list, folder-create, and upload request consequently returns HTTP 503 with code
`unavailable`. The browser still renders enabled mutation controls and an empty-state
message, making a disabled service look like an empty directory whose controls do
nothing.

The currently displayed declaration can also outlive its physical volume. Once the
gateway is enabled, daemon inspection may return `not_found`; this is distinct from a
disabled file service and must be presented separately.

## Design

### Local development configuration

Provide a repository-owned local development launcher/configuration for the UI gateway
that sets `LOCAL_VOLUME_ROOT` to a narrow, explicit directory. The directory must match
the root used for UI-managed local volumes in the development topology. It must be an
absolute clean path and must not broaden access to the workspace, daemon database, or
arbitrary host directories.

Production behavior remains fail-closed: the Go gateway will not gain an implicit
fallback root, and deployments that omit `LOCAL_VOLUME_ROOT` will continue returning
503.

### Browser states

`VolumeFileBrowser` will classify API failures by status/code:

- `503 / unavailable`: show a Chinese message that the volume file service is not
  configured and disable create-folder, upload, reload, and other file mutations.
- `404 / not_found`: show a Chinese message that the physical volume does not exist and
  instruct the administrator to apply the project first; disable file mutations.
- Other errors: retain the returned safe error message and allow retry when appropriate.
- A successful reload clears the unavailable/not-found state and restores controls.

The directory-empty message appears only after a successful list response, never after
an error.

## Data Flow

1. The local launcher starts the UI gateway with the restricted volume root.
2. The browser requests `/api/volume-files` with project key, physical volume name, and
   relative path.
3. The gateway asks the daemon to inspect immutable volume metadata, verifies managed
   ownership labels and that the physical path is beneath the configured root, then
   performs filesystem operations through its existing guarded storage layer.
4. The browser renders entries on success or a classified recovery message on failure.

No browser-to-daemon filesystem shortcut is introduced.

## Testing

- Add a configuration contract test proving the local gateway launcher supplies the
  restricted `LOCAL_VOLUME_ROOT`.
- Add component regressions for 503 and 404 responses, disabled controls, absence of the
  false "目录为空" state, and recovery after a successful reload.
- Run focused component tests, the UI test suite relevant to volume files, and existing
  Go volume-file/app tests.

## Non-goals

- No changes to the `agent-compose` repository or daemon API.
- No automatic creation of missing physical volumes from the file browser.
- No implicit access to Docker's global volume directory or arbitrary host paths.
- No redesign of the resource panel outside error and control states.
