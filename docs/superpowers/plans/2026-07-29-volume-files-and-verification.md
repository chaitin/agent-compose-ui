# Volume Files and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide secure local Volume file operations, integrate them into the data panel, and verify the complete feature against a real daemon.

**Architecture:** The Go gateway first resolves a Volume through the existing daemon Inspect API, accepts only managed local Volumes, maps the daemon path under a configured shared root, then performs symlink-safe relative file operations. The browser never receives or submits physical paths.

**Tech Stack:** Go `net/http`, Connect JSON/HTTP proxy calls, Svelte 5, Docker Compose, Go test, Vitest, Playwright/Bun E2E.

---

**Hard boundary:** Every changed file must be inside `agent-compose-ui`. Volume file access must be implemented by the Go gateway and UI-owned deployment mounts; do not modify daemon APIs, protobufs, storage code, or tests.

### Task 1: Volume storage configuration and deployment

**Files:**
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`
- Modify: `docker/docker-compose.full.yml`
- Modify: `docker/compose-project-env.test.mjs`
- Modify: `docker/README.md`

- [ ] **Step 1: Write failing config and Compose tests**

Assert `LOCAL_VOLUME_ROOT` must be an absolute clean path and full Compose sets it to `/data/volumes/local` with a read-write mount of only `${AGENT_COMPOSE_DATA_DIR}/volumes/local`.

- [ ] **Step 2: Verify failure**

Run: `go test ./internal/config -count=1 && bun test docker/compose-project-env.test.mjs`

Expected: FAIL because the variable and mount are absent.

- [ ] **Step 3: Add configuration and narrow mount**

```yaml
environment:
  LOCAL_VOLUME_ROOT: /data/volumes/local
volumes:
  - ${AGENT_COMPOSE_DATA_DIR:-./data}/volumes/local:/data/volumes/local
```

Do not make `/data/agent-compose` writable.

- [ ] **Step 4: Run focused tests**

Run: `go test ./internal/config -count=1 && bun test docker/compose-project-env.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/config docker/docker-compose.full.yml docker/compose-project-env.test.mjs docker/README.md
git commit -m "feat(volumes): mount local volume data into gateway"
```

### Task 2: Daemon Volume resolver

**Files:**
- Create: `internal/volumefiles/resolver.go`
- Create: `internal/volumefiles/resolver_test.go`

- [ ] **Step 1: Write failing resolver tests**

Stub daemon Inspect responses and cover: managed local success, wrong project label, wrong driver, missing managed label, path outside root, and daemon failure.

- [ ] **Step 2: Verify failure**

Run: `go test ./internal/volumefiles -run TestResolver -count=1`

Expected: FAIL because package is absent.

- [ ] **Step 3: Implement resolver boundary**

```go
type VolumeInspector interface { InspectVolume(context.Context, string) (Volume, error) }
type Resolver struct { Inspector VolumeInspector; Root string }
func (r Resolver) Resolve(ctx context.Context, projectKey, volumeName string) (string, error)
```

Require driver `local`, managed/project labels, and a resolved path beneath `Root`; never trust a client path.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/volumefiles -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/volumefiles
git commit -m "feat(volumes): resolve managed local volume roots"
```

### Task 3: Volume file storage and HTTP API

**Files:**
- Create: `internal/volumefiles/storage.go`
- Create: `internal/volumefiles/storage_test.go`
- Create: `internal/volumefiles/handler.go`
- Create: `internal/volumefiles/handler_test.go`
- Modify: `internal/app/server.go`
- Modify: `internal/app/server_test.go`

- [ ] **Step 1: Write failing security and behavior tests**

Cover list, preview cap, atomic write with SHA-256 conflict, multipart upload cap, download, mkdir, delete, recursive confirmation, traversal, encoded traversal, control characters, symlink parent/leaf, FIFO/device rejection, file-count cap, and context cancellation.

- [ ] **Step 2: Verify failure**

Run: `go test ./internal/volumefiles ./internal/app -count=1`

Expected: FAIL for missing storage/handler.

- [ ] **Step 3: Implement APIs**

```text
GET    /api/volume-files?projectKey=&volume=&path=
GET    /api/volume-files/preview?projectKey=&volume=&path=
GET    /api/volume-files/download?projectKey=&volume=&path=
POST   /api/volume-files/upload
PUT    /api/volume-files/file
POST   /api/volume-files/folder
DELETE /api/volume-files/file
DELETE /api/volume-files/folder
```

Use `http.MaxBytesReader`, `os.Root` where available, `Lstat` for every path segment, `Content-Disposition` sanitization, and same-directory atomic rename.

- [ ] **Step 4: Run Go tests and race tests**

Run: `go test ./internal/volumefiles ./internal/app -count=1 && go test -race ./internal/volumefiles -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/volumefiles internal/app/server.go internal/app/server_test.go
git commit -m "feat(volumes): add secure local volume file API"
```

### Task 4: Volume file browser integration

**Files:**
- Create: `src/lib/volume-files/api.ts`
- Create: `src/lib/volume-files/api.test.ts`
- Create: `src/components/mounts/VolumeFileBrowser.svelte`
- Create: `src/components/mounts/VolumeFileBrowser.component.test.ts`
- Modify: `src/components/mounts/DataMountPanel.svelte`

- [ ] **Step 1: Write failing UI tests**

Cover list, preview, upload, download URL, mkdir, delete confirmation, stale response suppression after project/Volume switch, conflict messaging, and hidden browser for bind/external Volumes.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/lib/volume-files src/components/mounts/VolumeFileBrowser.component.test.ts`

Expected: FAIL because browser is absent.

- [ ] **Step 3: Implement typed API and browser**

```ts
export type VolumeFileEntry = { name: string; path: string; dir: boolean; size: number; mtimeMs: number };
export type VolumePreview = { path: string; content: string; sha256: string; truncated: boolean };
```

Use generation counters/AbortController for stale requests and never render server physical paths.

- [ ] **Step 4: Run frontend tests**

Run: `npx vitest run src/lib/volume-files src/components/mounts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/volume-files src/components/mounts
git commit -m "feat(volumes): add persistent data file browser"
```

### Task 5: System resource integration and full verification

**Files:**
- Modify: `src/pages/CacheListView.svelte`
- Modify: `src/pages/VolumeListView.svelte`
- Modify: `src/pages/CacheVolumeViews.test.ts`
- Create: `e2e/real-data/project-resources.test.ts`
- Modify: `e2e/real-data/run.ts`

- [ ] **Step 1: Add failing integration assertions**

Verify system cache and Volume pages retain current list/inspect/prune/remove behavior, while managed Volume details link back to the project resource view without exposing physical paths there.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/pages/CacheVolumeViews.test.ts`

Expected: FAIL for missing managed-resource navigation assertions.

- [ ] **Step 3: Implement project linkage and E2E scenario**

The E2E scenario must create a Skill, create and mount persistent data, enable npm cache, choose a read-only share, apply, run an Agent, write/read a Volume file, unmount, delete, and assert the Workspace behavior is unchanged. It may run against an existing daemon but must not alter the `agent-compose` source checkout.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
go test ./...
npm run test:all
npm run build
bun run test:e2e:real
```

Expected: all commands exit 0; real E2E reports every project-resource checkpoint passed.

- [ ] **Step 5: Request code review and commit final integration**

```bash
git add src/pages e2e/real-data
git commit -m "feat(resources): complete project resource integration"
```
