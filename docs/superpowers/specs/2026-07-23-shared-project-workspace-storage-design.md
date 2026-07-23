# Shared Project Workspace Storage Design

## Goal

Make project-local workspaces readable at the same absolute path by the UI file gateway and the Agent Compose daemon, without changing the Agent Compose backend or its V2 `provider: local` workspace behavior.

The storage binding is independent from the project lifecycle. Drafts and saved projects both receive a stable, opaque storage key when a canonical source identity is first required and retain it when a draft is saved or enabled.

## Scope

This change covers:

- configurable shared project storage in the Go UI gateway;
- server-generated storage bindings and canonical compose paths;
- project-relative workspace file operations;
- frontend binding creation and persistence;
- Docker mounts and deployment documentation;
- actionable storage and path-safety errors;
- compatibility handling for legacy UI-local workspace paths.

All implementation changes are restricted to the `agent-compose-ui` repository: its Svelte frontend, its Go gateway, its scripts, tests, and deployment files. The separate Agent Compose backend is read-only for this work. This design does not change Agent Compose workspace snapshots, sandbox provisioning, V2 protobuf types, sandbox-to-project synchronization, or the daemon workspace upload API.

## Storage Identity and Layout

The gateway reads `PROJECT_STORAGE_ROOT`. Local development defaults to the absolute path `${TMPDIR:-/tmp}/agent-compose-ui/projects`; Docker deployments explicitly set `/data/work/projects`. The production deployment documentation requires an explicit shared root and warns that the local-development default is not suitable for separated hosts.

When creating a binding, the gateway generates a cryptographically random key with a fixed format such as `ws_<lowercase hex>`. The key is not derived from a draft ID, project ID, project name, or browser-provided path.

Each binding has this layout:

```text
<PROJECT_STORAGE_ROOT>/<projectKey>/agent-compose.yml
<PROJECT_STORAGE_ROOT>/<projectKey>/workspace/
```

`agent-compose.yml` is a logical compose path and need not be materialized. Its parent directory must exist. The workspace directory is created only when a valid local workspace is configured or a file operation needs it. The canonical compose path returned by the gateway is the exact `sourcePath` submitted to the V2 project API.

The binding remains stable when a draft becomes a saved project. Project rename, editing, and enable operations do not change the key or move files. A new project's canonical source identity is allocated on the first operation that needs a source path (validation, save, run, or Workspace file management), because the existing UI deliberately uses unique compose paths to isolate deleted-and-recreated projects. Projects without a local workspace may therefore have an empty project directory, but do not create a `workspace` directory and otherwise retain their existing save and run behavior.

## Gateway Configuration

The Go gateway configuration adds `ProjectStorageRoot` and optional `LegacyProjectStorageRoot`. Both configured values must be absolute, clean paths. Startup rejects relative paths. The storage service creates the project root on first binding and reports a specific error if it cannot create or write it; startup does not require a workspace directory for projects that never use one.

The frontend never constructs `/agent-compose-ui/projects` or `/data/work/projects` paths. Only the gateway turns a storage key into an absolute path.

## Binding API

The gateway adds:

```http
POST /api/project-storage/bind
Content-Type: application/json
```

For a new binding the request omits both identifiers. The gateway generates the key, creates the project directory, and returns:

```json
{
  "projectKey": "ws_7f3c2a...",
  "sourcePath": "/data/work/projects/ws_7f3c2a.../agent-compose.yml",
  "workspacePath": "workspace"
}
```

For an existing browser draft binding, the request contains the previously issued `projectKey`. The gateway validates the format, verifies that the binding directory exists directly beneath the configured root, and returns the same canonical response. The request can also ask to ensure the validated relative `workspacePath`.

The gateway also provides a resolve operation for daemon-loaded projects. This operation accepts a candidate `sourcePath` only as an identifier and succeeds solely when it exactly matches `<PROJECT_STORAGE_ROOT>/<validProjectKey>/agent-compose.yml` and the binding directory exists. The candidate path is never used directly for filesystem access. This distinction preserves server authority while allowing projects, whose V2 summary has no `projectKey` field, to recover a binding.

`BrowserDraft` gains optional `projectKey` and `sourcePath` fields and its local-storage schema advances to version 2 with a version-1 migration. Creating a binding for a not-yet-saved draft immediately persists a minimal draft record so a reload cannot orphan freshly uploaded files. Saved projects persist the canonical source path through the existing V2 `ProjectSummary.sourcePath`; they do not require a new backend field. The frontend must not maintain a second project-to-key mapping that can drift from `sourcePath`.

## Workspace File API

Existing workspace UI capabilities remain available: list, upload, folder upload, download, create folder, delete file, and delete folder.

The local workspace endpoints switch from browser-provided `sourcePath` to:

- `projectKey` identifying the server-issued binding;
- a relative `workspacePath`, normally `workspace`;
- an operation-specific relative file or folder path.

The server resolves all paths from `ProjectStorageRoot`. The old arbitrary-absolute-`sourcePath` request contract is not used by the frontend after this change.

The binding and all workspace file routes are wrapped by the existing Go authentication manager. This closes the current gap where `/api/local-workspace/*` is routed directly to the file handler while daemon and script routes require a session in password mode.

## Path and Symlink Safety

The server enforces all of the following:

- project keys match the server-issued fixed format;
- workspace paths are non-empty and relative;
- absolute workspace paths and any `..` component are rejected;
- file paths are non-empty and relative and contain no `..` component;
- filesystem operations use a directory-scoped API that prevents symlink traversal at operation time (Go 1.24 `os.Root` or an equivalently tested descriptor-relative implementation), rather than relying only on `Lstat` followed by a path-based operation;
- every existing path component from the project directory to the target rejects symbolic links, including upload parents and recursive delete targets;
- resolved paths must remain descendants of the selected project directory and workspace root;
- prefix checks use `filepath.Rel` containment rather than string prefixes;
- one project key cannot be smuggled through a workspace or file path to reach another project.

This is path isolation within the application's existing authentication model. The product currently gives every authenticated user full UI capabilities; per-user project authorization remains outside this change.

## Frontend Lifecycle

The Workspace panel derives whether the YAML has a valid local, relative workspace binding. Storage identity creation is coordinated by one deduplicating frontend service so Svelte effects, validation, save, and upload cannot race and create multiple bindings for one draft.

The flow is:

```text
Validate, save, run, or use Workspace file management
→ reuse a validated binding when present
→ otherwise request a new server binding
→ atomically persist the draft binding, or retain the saved project's canonical sourcePath
→ perform file operations using projectKey and relative workspacePath
→ save or enable using the canonical sourcePath unchanged
```

Temporary `/tmp/agent-compose-ws-*` source paths and best-effort client-side file migration are removed. Upload cannot begin until a durable binding has been created successfully.

For a saved daemon project with an unmanaged source path, adding or using a local workspace creates a binding and supplies an explicit `sourcePathOverride` to preview and apply. This is necessary because the current `prepareApplyRequest` always prefers `currentProject.summary.sourcePath`. The UI does not mutate the in-memory project summary before Apply succeeds; on failure it retains the old project and binding state for retry. A run requested from the editor uses the already-previewed source-path override and starts agents only after Apply succeeds.

For a new project without a local workspace, validation/save still obtains a unique managed compose path, preserving the recreated-project isolation introduced by the existing UI. It creates only the project directory, not `workspace/`.

## YAML Rules

The supported configuration remains:

```yaml
agents:
  worker:
    workspace:
      provider: local
      path: workspace
```

The frontend and gateway reject absolute `workspace.path` values and values containing `..`. Other providers continue to disable local file management. A project without a workspace continues through existing save and run flows unchanged.

## Legacy Compatibility

A source path beginning with `/agent-compose-ui/projects/` is legacy and is never treated as a trusted new binding.

When a user opens Workspace management for a legacy project, the gateway offers one-time migration only when `LEGACY_PROJECT_STORAGE_ROOT` is explicitly configured and mounted. The browser supplies a legacy draft identifier, not an arbitrary legacy absolute path. The gateway resolves it strictly beneath that configured root.

Migration creates a temporary sibling of the new binding, recursively copies regular files without following symbolic links, and atomically renames the staged directory into place only after the complete copy succeeds. A failed copy removes its staging directory and never returns a new canonical source path. Existing source data is never deleted automatically.

If the old directory is absent or unsafe, the UI reports that the legacy workspace is unavailable and asks for administrator migration or file re-upload. It must not create an empty directory and silently present migration as successful.

Automatic deletion of legacy or orphaned project directories is outside scope. Project deletion does not delete shared workspace data in this change.

## Errors and Run Guard

The gateway returns structured error codes for invalid binding, unsafe path, missing binding, storage unavailable, storage not writable, and legacy source unavailable. The UI maps them to actionable Chinese messages.

Before saving or running a project that declares `provider: local`, the UI requires a durable binding and canonical shared `sourcePath`. A legacy, temporary, missing, or failed binding blocks the action with a Workspace-specific message. The guard is shared by the editor Save/Run flow and manual run entry points that can create a new run (`RunAgentModal` and Scheduler run actions). Operations against an already-created sandbox are not falsely treated as new workspace preparation.

If the daemon later reports workspace preparation failure, the UI labels it as Workspace preparation/storage failure. It must not present it as Agent execution success or infer success from an absent/zero exit code.

Without changing the Agent Compose backend, the UI gateway cannot proactively prove that a remote daemon sees the same filesystem. It can validate its own mount, provide exact deployment diagnostics, and classify a workspace-preparation error returned by the daemon. It must not claim to emit a definitive pre-run “backend storage mismatch” error. Autonomous scheduler execution remains enforced by the daemon using the source path saved when the project was applied; the UI cannot intercept a scheduler firing outside a browser session.

## Deployment

In the full Docker stack, both web and Agent Compose mount the same host work directory at `/data/work`, and the web gateway receives:

```text
PROJECT_STORAGE_ROOT=/data/work/projects
```

The frontend-only Compose file adds an explicit configurable host/shared-storage mount at `/data/work` and sets the same gateway root. Operators must separately mount that same NFS, cloud filesystem, or host directory at `/data/work` on the external daemon. Network connectivity alone is insufficient. The full-stack change modifies only `agent-compose-ui/docker/docker-compose.full.yml`; it configures the existing backend container but does not modify backend source code or images.

## Testing

Go unit tests cover configuration validation, random key format, canonical source path generation, exact source-path resolution, idempotent binding, workspace-path validation, file-path validation, and containment.

Security tests cover unauthenticated access in password mode, absolute paths, `..`, sibling project access attempts, malicious upload names, symbolic-link swap attempts at each relevant level, and delete operations against directories outside the binding.

Gateway integration tests create bindings under a temporary storage root, upload nested files, read them directly through the returned canonical path's parent, and verify three bindings remain isolated.

Frontend tests cover deduplicated binding creation for drafts and saved projects, version-1 draft migration, immediate binding persistence, persistence across draft enablement, stable source paths, source-path override precedence, failed binding/apply behavior, relevant manual run guards, legacy warnings, and the no-workspace regression case.

Docker configuration tests verify that web and daemon mount the same host work directory at `/data/work` and that the gateway uses `/data/work/projects`.

Where a real daemon and sandbox runtime are available, the end-to-end scenario uploads a directory, saves the project, runs the agent, and verifies the files in `/workspace`. Concurrent runs must receive independent snapshots, and sandbox writes must not modify project source files. These daemon snapshot semantics are verified without changing daemon code.

## Acceptance Criteria

- Uploaded files exist beneath the gateway-configured shared project root.
- The canonical `sourcePath` submitted by the UI is exactly the path visible to the daemon.
- Draft enablement retains the same storage key and files.
- Draft and non-draft flows both create bindings when a canonical source identity or Workspace is first required, without duplicate bindings under concurrent UI effects.
- Multiple projects and concurrent runs do not mix files.
- Absolute paths, traversal, symbolic links, and cross-project path construction are rejected.
- Missing shared storage produces a specific, actionable error.
- Projects without workspaces continue to save and run normally.
- The full Docker stack and documented separated deployment use identical absolute mount paths.
