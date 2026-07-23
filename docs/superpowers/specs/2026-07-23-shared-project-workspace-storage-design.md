# Shared Project Workspace Storage Design

## Goal

Make project-local workspaces readable at the same absolute path by the UI file gateway and the Agent Compose daemon, without changing the Agent Compose backend or its V2 `provider: local` workspace behavior.

The storage binding is independent from the project lifecycle. Drafts and saved projects both receive a stable, opaque storage key on first use and retain it when a draft is saved or enabled.

## Scope

This change covers:

- configurable shared project storage in the Go UI gateway;
- server-generated storage bindings and canonical compose paths;
- project-relative workspace file operations;
- frontend binding creation and persistence;
- Docker mounts and deployment documentation;
- actionable storage and path-safety errors;
- compatibility handling for legacy UI-local workspace paths.

It does not change Agent Compose workspace snapshots, sandbox provisioning, V2 protobuf types, sandbox-to-project synchronization, or the daemon workspace upload API.

## Storage Identity and Layout

The gateway reads `PROJECT_STORAGE_ROOT`, defaulting to a documented development-safe location and explicitly setting `/data/work/projects` in Docker deployments.

On first workspace use, the gateway generates a cryptographically random key with a fixed format such as `ws_<lowercase hex>`. The key is not derived from a draft ID, project ID, project name, or browser-provided path.

Each binding has this layout:

```text
<PROJECT_STORAGE_ROOT>/<projectKey>/agent-compose.yml
<PROJECT_STORAGE_ROOT>/<projectKey>/workspace/
```

`agent-compose.yml` is a logical compose path and need not be materialized. Its parent and the workspace directory must exist. The canonical compose path returned by the gateway is the exact `sourcePath` submitted to the V2 project API.

The binding remains stable when a draft becomes a saved project. Project rename, editing, and enable operations do not change the key or move files. Projects without a local workspace do not create storage directories.

## Gateway Configuration

The Go gateway configuration adds `ProjectStorageRoot`. `PROJECT_STORAGE_ROOT` must be an absolute, clean path. Startup rejects relative paths and an unusable configured value. The gateway creates the root when needed and reports a specific error if it cannot create or write it.

The frontend never constructs `/agent-compose-ui/projects` or `/data/work/projects` paths. Only the gateway turns a storage key into an absolute path.

## Binding API

The gateway adds:

```http
POST /api/project-storage/bind
Content-Type: application/json
```

For a new binding the request omits `projectKey`. The gateway generates the key, creates the project and workspace directories, and returns:

```json
{
  "projectKey": "ws_7f3c2a...",
  "sourcePath": "/data/work/projects/ws_7f3c2a.../agent-compose.yml",
  "workspacePath": "workspace"
}
```

For an existing binding, the request contains the previously issued `projectKey`. The gateway validates the format, verifies that the binding directory exists beneath the configured root, ensures the workspace directory, and returns the same canonical response. It never accepts a client-selected absolute source path.

The frontend persists both `projectKey` and `sourcePath` in its draft/project-side state. For daemon-loaded projects created by this version, it may recover the key only by asking the gateway to parse and validate the canonical `sourcePath`; browser string slicing is not authoritative.

## Workspace File API

Existing workspace UI capabilities remain available: list, upload, folder upload, download, create folder, delete file, and delete folder.

The local workspace endpoints switch from browser-provided `sourcePath` to:

- `projectKey` identifying the server-issued binding;
- a relative `workspacePath`, normally `workspace`;
- an operation-specific relative file or folder path.

The server resolves all paths from `ProjectStorageRoot`. The old arbitrary-absolute-`sourcePath` request contract is not used by the frontend after this change.

## Path and Symlink Safety

The server enforces all of the following:

- project keys match the server-issued fixed format;
- workspace paths are non-empty and relative;
- absolute workspace paths and any `..` component are rejected;
- file paths are non-empty and relative and contain no `..` component;
- every existing path component from the project directory to the target is checked with `Lstat` and symbolic links are rejected;
- parent directories created for uploads are checked before the destination file is opened;
- resolved paths must remain descendants of the selected project directory and workspace root;
- prefix checks use `filepath.Rel` containment rather than string prefixes;
- one project key cannot be smuggled through a workspace or file path to reach another project.

This is path isolation within the application's existing authentication model. The product currently gives every authenticated user full UI capabilities; per-user project authorization remains outside this change.

## Frontend Lifecycle

The Workspace panel derives whether the YAML has a valid local, relative workspace binding. It creates a storage binding lazily only when Workspace file management is used; merely opening or saving a project without a workspace does not allocate storage.

The flow is:

```text
Open or use Workspace file management
→ reuse a validated binding when present
→ otherwise request a new server binding
→ persist projectKey and canonical sourcePath in current UI project state
→ perform file operations using projectKey and relative workspacePath
→ save or enable using the canonical sourcePath unchanged
```

Temporary `/tmp/agent-compose-ws-*` source paths and best-effort client-side file migration are removed. Upload cannot begin until a durable binding has been created successfully.

For a saved daemon project with no new binding, first use creates one and marks the project as needing save/apply so that the daemon receives the new canonical `sourcePath` before the project can be run with the local workspace.

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

When a user opens Workspace management for a legacy project, the gateway may offer a one-time migration only when it can safely validate and read the legacy workspace on its own filesystem. Migration creates a new binding, recursively copies regular files without following symbolic links, and returns the new canonical source path only after the complete copy succeeds.

If the old directory is absent or unsafe, the UI reports that the legacy workspace is unavailable and asks for administrator migration or file re-upload. It must not create an empty directory and silently present migration as successful.

Automatic deletion of legacy or orphaned project directories is outside scope. Project deletion does not delete shared workspace data in this change.

## Errors and Run Guard

The gateway returns structured error codes for invalid binding, unsafe path, missing binding, storage unavailable, storage not writable, and legacy source unavailable. The UI maps them to actionable Chinese messages.

Before saving or running a project that declares `provider: local`, the UI requires a durable binding and canonical shared `sourcePath`. A legacy, temporary, missing, or failed binding blocks the action with a Workspace-specific message.

If the daemon later reports workspace preparation failure, the UI labels it as Workspace preparation/storage failure. It must not present it as Agent execution success or infer success from an absent/zero exit code.

The UI cannot prove remote filesystem visibility from HTTP connectivity alone. Deployment diagnostics explain that the gateway and daemon must mount the same storage at the same absolute path.

## Deployment

In the full Docker stack, both web and Agent Compose mount the same host work directory at `/data/work`, and the web gateway receives:

```text
PROJECT_STORAGE_ROOT=/data/work/projects
```

The frontend-only Compose file documents and exposes an explicit host/shared-storage mount for deployments using an external daemon. Operators must mount the same NFS, cloud filesystem, or host directory at `/data/work` on both sides. Network connectivity alone is insufficient.

## Testing

Go unit tests cover configuration validation, random key format, canonical source path generation, idempotent binding, workspace-path validation, file-path validation, and containment.

Security tests cover absolute paths, `..`, sibling project access attempts, malicious upload names, symbolic links at each relevant level, and delete operations against directories outside the binding.

Gateway integration tests create bindings under a temporary storage root, upload nested files, read them directly through the returned canonical path's parent, and verify three bindings remain isolated.

Frontend tests cover lazy creation for drafts and saved projects, persistence across draft enablement, stable source paths, failed binding behavior, run/save guards, legacy warnings, and the no-workspace regression case.

Docker configuration tests verify that web and daemon mount the same host work directory at `/data/work` and that the gateway uses `/data/work/projects`.

Where a real daemon and sandbox runtime are available, the end-to-end scenario uploads a directory, saves the project, runs the agent, and verifies the files in `/workspace`. Concurrent runs must receive independent snapshots, and sandbox writes must not modify project source files. These daemon snapshot semantics are verified without changing daemon code.

## Acceptance Criteria

- Uploaded files exist beneath the gateway-configured shared project root.
- The canonical `sourcePath` submitted by the UI is exactly the path visible to the daemon.
- Draft enablement retains the same storage key and files.
- Draft and non-draft flows both create bindings on first Workspace use.
- Multiple projects and concurrent runs do not mix files.
- Absolute paths, traversal, symbolic links, and cross-project path construction are rejected.
- Missing shared storage produces a specific, actionable error.
- Projects without workspaces continue to save and run normally.
- The full Docker stack and documented separated deployment use identical absolute mount paths.
