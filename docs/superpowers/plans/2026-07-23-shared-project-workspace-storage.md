# Shared Project Workspace Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store UI-managed project workspaces beneath a configurable path shared with Agent Compose, while keeping draft-to-project storage identity stable and rejecting unsafe filesystem access.

**Architecture:** The `agent-compose-ui` Go gateway owns opaque storage keys, canonical compose paths, authentication, and directory-scoped file access. The Svelte frontend persists binding metadata for browser drafts, recovers saved-project bindings from canonical `sourcePath`, and supplies an explicit source-path override during Apply. Docker mounts the same host directory at `/data/work` in the UI gateway and the unchanged Agent Compose container.

**Tech Stack:** Go 1.24 `net/http` and `os.Root`, Svelte 5/TypeScript, Bun/Vitest, Docker Compose.

---

### Task 1: Configure the shared storage root

**Files:**
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`
- Modify: `internal/app/server.go`

- [ ] **Step 1: Write failing configuration tests** for the local-development default, `/data/work/projects`, relative-root rejection, and optional absolute legacy root.

```go
func TestLoadProjectStoragePaths(t *testing.T) {
    cfg, err := Load(env(map[string]string{"SCRIPT_SERVICE_TOKEN":"token", "PROJECT_STORAGE_ROOT":"/data/work/projects"}))
    if err != nil { t.Fatal(err) }
    if cfg.ProjectStorageRoot != "/data/work/projects" { t.Fatalf("root = %q", cfg.ProjectStorageRoot) }
}
```

- [ ] **Step 2: Run `GOMODCACHE=/tmp/agent-compose-ui-gomod go test ./internal/config`** and verify the new tests fail because `ProjectStorageRoot` is absent.
- [ ] **Step 3: Add `ProjectStorageRoot` and `LegacyProjectStorageRoot` to `Config`**, validate configured paths with `filepath.IsAbs`/`filepath.Clean`, and pass the values into the local filesystem handler.
- [ ] **Step 4: Re-run the config tests** and verify they pass.
- [ ] **Step 5: Commit** with `feat(gateway): configure shared project storage`.

### Task 2: Implement secure project bindings and file resolution

**Files:**
- Create: `internal/localfs/storage.go`
- Create: `internal/localfs/storage_test.go`
- Rewrite: `internal/localfs/handler.go`
- Modify: `internal/localfs/handler_test.go`

- [ ] **Step 1: Write failing storage tests** covering generated `ws_<32 hex>` keys, canonical compose paths, idempotent recovery, exact source-path resolution, traversal rejection, sibling-prefix rejection, and symlink rejection.

```go
binding, err := storage.CreateBinding(false)
if err != nil { t.Fatal(err) }
if !regexp.MustCompile(`^ws_[0-9a-f]{32}$`).MatchString(binding.ProjectKey) { t.Fatalf("key = %q", binding.ProjectKey) }
if binding.SourcePath != filepath.Join(root, binding.ProjectKey, "agent-compose.yml") { t.Fatal(binding.SourcePath) }
```

- [ ] **Step 2: Run `GOMODCACHE=/tmp/agent-compose-ui-gomod go test ./internal/localfs`** and verify failure because `Storage` does not exist.
- [ ] **Step 3: Implement `Storage`** with random keys, exact canonical resolution, component validation, and `os.OpenRoot`-scoped list/read/write/mkdir/remove operations that reject symlinks.
- [ ] **Step 4: Write failing HTTP tests** for `POST /api/project-storage/bind`, resolve, list, upload, download, folder creation, file deletion, recursive folder deletion, structured errors, and project isolation.
- [ ] **Step 5: Replace arbitrary `sourcePath` handlers** with `projectKey`-based handlers using `Storage`; retain endpoint capabilities but remove filesystem authority from browser paths.
- [ ] **Step 6: Run the localfs test package** and verify all tests pass.
- [ ] **Step 7: Commit** with `feat(gateway): add secure project workspace bindings`.

### Task 3: Protect workspace routes with existing authentication

**Files:**
- Modify: `internal/app/server.go`
- Modify: `internal/app/server_test.go`

- [ ] **Step 1: Write a failing password-mode route test** asserting unauthenticated binding and local workspace requests return `401`, while a valid login cookie reaches the handler.
- [ ] **Step 2: Run `GOMODCACHE=/tmp/agent-compose-ui-gomod go test ./internal/app`** and verify unauthenticated local workspace access currently succeeds or bypasses the auth manager.
- [ ] **Step 3: Wrap one combined project-storage handler with `manager.Require`** and route `/api/project-storage/*` and `/api/local-workspace/*` through it.
- [ ] **Step 4: Re-run app tests** and verify they pass.
- [ ] **Step 5: Commit** with `fix(auth): protect project workspace storage routes`.

### Task 4: Persist and recover frontend storage bindings

**Files:**
- Create: `src/lib/workspace/bindings.ts`
- Create: `src/lib/workspace/bindings.test.ts`
- Modify: `src/lib/stores.svelte.ts`
- Modify: `src/lib/stores.test.ts`
- Modify: `test/stores.test.ts`
- Modify: `src/lib/workspace/local-api.ts`

- [ ] **Step 1: Write failing draft schema tests** that migrate v1 drafts, retain optional `projectKey`/`sourcePath`, immediately persist a binding, and keep it when the draft is selected again.
- [ ] **Step 2: Run `bun test src/lib/stores.test.ts`** and verify the new metadata assertions fail.
- [ ] **Step 3: Upgrade browser drafts to schema v2** and add focused store methods to read and atomically persist a draft binding without changing typed YAML.
- [ ] **Step 4: Write failing binding-client tests** for one in-flight request per draft, saved-project resolution, retry after failure, and structured Chinese error mapping.
- [ ] **Step 5: Implement the binding API client and deduplicating coordinator**; update `local-api.ts` so file calls send only `projectKey`, relative workspace path, and relative target path.
- [ ] **Step 6: Run targeted frontend tests** and verify they pass.
- [ ] **Step 7: Commit** with `feat(ui): persist shared workspace bindings`.

### Task 5: Integrate binding identity with validation, Apply, and Workspace UI

**Files:**
- Modify: `src/lib/toolbar-actions.ts`
- Modify: `src/lib/toolbar-actions.test.js`
- Modify: `src/components/Toolbar.svelte`
- Modify: `src/lib/workspace/store.svelte.ts`
- Modify: `src/components/workspace/WorkspacePanel.svelte`
- Modify: `src/components/workspace/WorkspaceBindingBar.svelte`
- Modify: `src/components/YamlEditor.svelte`
- Modify: `src/lib/workspace-create.ts`
- Modify relevant existing workspace component tests.

- [ ] **Step 1: Write failing toolbar tests** proving `sourcePathOverride` wins over an existing project path and the canonical draft path is reused for dry-run and Apply.
- [ ] **Step 2: Run `bun test src/lib/toolbar-actions.test.js`** and verify the override test fails.
- [ ] **Step 3: Add `sourcePathOverride` to preview/save options** and resolve canonical source identity before Validate or preview.
- [ ] **Step 4: Write failing Workspace store/component tests** proving temp `/tmp/agent-compose-ws-*` paths and best-effort migration are gone, upload waits for a durable binding, and saved-project binding failure is visible.
- [ ] **Step 5: Refactor Workspace state to use `projectKey`** and the coordinator; ensure local relative YAML paths only and keep non-local providers disabled.
- [ ] **Step 6: Run toolbar, store, and Workspace tests** and verify they pass.
- [ ] **Step 7: Commit** with `feat(ui): use canonical project paths for workspaces`.

### Task 6: Add run guards and legacy handling

**Files:**
- Create: `src/lib/workspace/preflight.ts`
- Create: `src/lib/workspace/preflight.test.ts`
- Modify: `src/modals/RunAgentModal.svelte`
- Modify: `src/modals/RunAgentModal.component.test.ts`
- Modify: `src/views/runtime/SchedulerListView.svelte`
- Modify: `src/views/runtime/SchedulerListView.component.test.ts`
- Modify: `internal/localfs/storage.go`
- Modify: `internal/localfs/storage_test.go`

- [ ] **Step 1: Write failing frontend preflight tests** for managed, missing, and legacy source paths when a project declares `provider: local`.
- [ ] **Step 2: Run the targeted preflight/component tests** and verify manual new-run actions are not yet blocked.
- [ ] **Step 3: Implement and integrate the shared preflight** into editor Run, `RunAgentModal`, and Scheduler manual run actions; do not block operations inside an existing sandbox.
- [ ] **Step 4: Write failing Go legacy migration tests** for disabled legacy storage, identifier traversal, symlinks, staging-copy failure, and successful atomic publication.
- [ ] **Step 5: Implement explicitly configured legacy migration** with staging and rename, without deleting the source.
- [ ] **Step 6: Run targeted Go and frontend tests** and verify they pass.
- [ ] **Step 7: Commit** with `feat(workspace): guard runs and migrate visible legacy data`.

### Task 7: Align deployment and documentation

**Files:**
- Modify: `docker/docker-compose.full.yml`
- Modify: `docker/docker-compose.yml`
- Modify: `docker/compose-project-env.test.mjs`
- Modify: `docker/README.md`
- Modify: `README.md`

- [ ] **Step 1: Extend the Compose test** to assert `PROJECT_STORAGE_ROOT=/data/work/projects` and identical `/data/work` container mounts.
- [ ] **Step 2: Run `bun test docker/compose-project-env.test.mjs`** and verify the new assertions fail.
- [ ] **Step 3: Update both Compose variants** with the shared mount and environment variable; document the external-daemon requirement and optional legacy mount.
- [ ] **Step 4: Re-run the Compose test** and verify it passes.
- [ ] **Step 5: Commit** with `docs(deploy): configure shared project workspace storage`.

### Task 8: Full verification

**Files:**
- Modify only files needed to fix failures introduced by Tasks 1–7.

- [ ] **Step 1: Run Go verification:** `GOMODCACHE=/tmp/agent-compose-ui-gomod go test ./...`.
- [ ] **Step 2: Run frontend static checks:** `bun run check`.
- [ ] **Step 3: Run all repository tests:** `bun run test:all`.
- [ ] **Step 4: Run the production build:** `bun run build`.
- [ ] **Step 5: Inspect `git diff --check` and `git status --short`**, preserving the user's untracked requirements document.
- [ ] **Step 6: Commit any verification-only fixes** with a focused message; do not modify or commit files outside `agent-compose-ui`.
