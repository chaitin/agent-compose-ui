# Project Image Build Management Design

## Goal

Bring the project image-build management workflow from `/root/agent/agent-compose-ui` into this repository without removing or replacing any existing resource-panel or project-activation behavior that is unrelated to image builds.

## Scope

The migration adds a project-resource "镜像" tab that derives build sources from the current YAML, lets users upload files into each relative `build.context`, checks that the configured Dockerfile is present, and connects that readiness check to the existing project activation and streamed `BuildImage` workflow.

The migration does not copy unrelated source-repository changes such as run statistics, sidebar restructuring, system settings, or server changes. Existing Scripts, Workspace, Skills, and data/mount resource tabs remain available. Existing image list, pull, inspect, remove, YAML parsing, and streamed image-build utilities remain in place.

## Architecture

### Build source mapping

A focused `project-image-files` module maps every agent with a YAML `build` block to a file source containing the agent name, image reference, context, storage path, Dockerfile, manageability, and validation error.

Relative build contexts under a project subdirectory are browser-manageable. Absolute contexts remain server-managed and continue through the existing image service. Project-root contexts and paths that escape the project or build context are rejected by the browser upload workflow.

The same module performs an activation-time readiness check through the existing project-storage binding and local workspace APIs. A relative build source is ready only when the configured Dockerfile exists at the expected path.

### Image resource panel

The existing resource panel gains an `images` tab alongside Scripts, Workspace, Skills, and data/mounts. It does not replace or simplify the existing tab implementation, accessibility behavior, binding flow, or component props.

The image panel parses the current editor YAML, lists build-enabled agents, resolves the active project or draft storage binding, and creates a dedicated `WorkspaceFileStore` rooted at the selected build context. It reuses the workspace tree and upload components. Folder upload strips the selected top-level directory so its contents land directly inside `build.context`.

`WorkspaceUpload` becomes reusable by accepting an optional file store, location label, and folder-root stripping option. Its defaults preserve all current Workspace behavior.

### Activation and build flow

The existing `createProjectImageBuildPlans`, `changedBuildAgentNames`, and streamed `runProjectImageBuildPlans` flow remains the build executor.

When activation preview is prepared:

1. Build plans resolve relative contexts from the canonical project source path, including first activation of a draft.
2. Only agents whose build configuration is new or changed are selected automatically.
3. Selected browser-managed build sources are checked for their Dockerfile.
4. If a required source is incomplete, activation preview stops, the image resource tab opens, and an actionable error toast identifies the image and missing file.
5. If all sources are ready, the confirmation shows build options and the existing streamed progress. Successful images remain on the daemon even if later project activation fails.

Projects without changed build definitions continue directly through the normal activation confirmation. Absolute server-managed contexts are not blocked by browser file checks.

## Error Handling

YAML parse failures produce an empty image-source list because the editor already owns YAML validation. Invalid image paths show a per-source message in the image panel. Storage-binding failures and missing build directories or Dockerfiles prevent activation only for selected changed builds and route the user to the image panel. Existing backend build failures continue to use the current streamed failure handling and result display.

## Compatibility

- Existing resource tabs and their keyboard/accessibility behavior are retained.
- Existing Workspace uploads use the same default singleton store and preserve the uploaded folder root.
- Existing projects with absolute daemon paths remain buildable by the server.
- Existing projects whose build configuration did not change are not rebuilt automatically.
- No protobuf, generated client, backend API, persistence schema, or image-list behavior changes.

## Testing

Tests cover path mapping, invalid and server-managed contexts, Dockerfile readiness, reusable upload defaults and folder-root stripping, image-tab integration without loss of existing tabs, opening the image tab on failed readiness checks, first-draft canonical path resolution, changed-only selection, unchanged-build activation, and the existing streamed success/failure behavior.

Focused Vitest and component tests run during implementation, followed by the repository's applicable typecheck/build/test gates.
