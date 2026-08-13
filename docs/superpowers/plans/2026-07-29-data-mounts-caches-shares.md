# Data Mounts, Caches, and Shares Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure persistent Volumes, dependency-cache presets, and allowlisted bind mounts through standard YAML.

**Architecture:** A pure TypeScript model derives project resources from YAML and produces focused mutations. The Go gateway exposes only administrator-configured shared-directory choices; daemon APIs remain the authority for Volume existence and project apply.

**Tech Stack:** TypeScript, Svelte 5, Go, ConnectRPC, Vitest, Go test.

---

**Hard boundary:** Every changed file must be inside `agent-compose-ui`. Existing daemon Volume, cache, project apply, and Sandbox APIs are immutable contracts.

### Task 1: Resource derivation and cache presets

**Files:**
- Create: `src/lib/project-resources/model.ts`
- Create: `src/lib/project-resources/model.test.ts`
- Create: `src/lib/project-resources/cache-presets.ts`
- Create: `src/lib/project-resources/cache-presets.test.ts`

- [ ] **Step 1: Write failing derivation tests**

Parse top-level Volumes and Agent mounts into logical resources, including shared usage and read-only state. Assert presets map npm to `/root/.npm`, pip to `/root/.cache/pip`, and tools to `/root/.cache`.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/lib/project-resources/model.test.ts src/lib/project-resources/cache-presets.test.ts`

Expected: FAIL for missing modules.

- [ ] **Step 3: Implement pure derivation APIs**

```ts
export type ProjectDataResource = { key: string; systemName: string; mounts: AgentMount[]; managed: boolean };
export function deriveProjectResources(yaml: string): ProjectDataResource[];
export const CACHE_PRESETS = {
  npm: { target: '/root/.npm', suffix: 'npm-cache' },
  pip: { target: '/root/.cache/pip', suffix: 'pip-cache' },
  tools: { target: '/root/.cache', suffix: 'tools-cache' },
} as const;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/project-resources`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-resources
git commit -m "feat(resources): derive mounts and cache presets"
```

### Task 2: Shared-directory allowlist API

**Files:**
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`
- Create: `internal/sharedirs/catalog.go`
- Create: `internal/sharedirs/catalog_test.go`
- Create: `internal/sharedirs/handler.go`
- Create: `internal/sharedirs/handler_test.go`
- Modify: `internal/app/server.go`

- [ ] **Step 1: Write failing config and handler tests**

Use `SHARED_DIRECTORY_CATALOG` as JSON:

```json
[{"id":"reference","name":"参考资料","path":"/shares/reference","writable":false}]
```

Reject relative paths, `/`, `/data`, `/var/run/docker.sock`, duplicates, and writable requests against read-only entries.

- [ ] **Step 2: Verify failure**

Run: `go test ./internal/config ./internal/sharedirs ./internal/app -count=1`

Expected: FAIL because catalog support is absent.

- [ ] **Step 3: Implement catalog parsing and read-only endpoint**

```go
type Entry struct { ID, Name, Path string; Writable bool }
func ParseCatalog(raw string) ([]Entry, error)
```

Expose authenticated `GET /api/shared-directories`; return IDs, names, and writable capability. The selected path is converted into YAML only after the client validates the returned catalog entry.

- [ ] **Step 4: Run Go tests**

Run: `go test ./internal/config ./internal/sharedirs ./internal/app -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/config internal/sharedirs internal/app/server.go
git commit -m "feat(resources): add shared directory allowlist"
```

### Task 3: Data and mounts panel

**Files:**
- Create: `src/lib/project-resources/shared-directories.ts`
- Create: `src/lib/project-resources/shared-directories.test.ts`
- Create: `src/components/mounts/DataMountPanel.svelte`
- Create: `src/components/mounts/DataMountPanel.component.test.ts`
- Modify: `src/components/ResourcePanel.svelte`

- [ ] **Step 1: Write failing component tests**

Cover creating an isolated persistent Volume, mounting one Volume to two Agents intentionally, toggling npm/pip presets, selecting a share, default read-only behavior, unmount-only, and deletion confirmation.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/components/mounts src/lib/project-resources/shared-directories.test.ts`

Expected: FAIL because panel and client are absent.

- [ ] **Step 3: Implement panel with explicit editor callbacks**

```ts
interface Props {
  yaml: string;
  projectKey: string;
  onYamlChange: (yaml: string) => void;
  onApply: () => Promise<void>;
}
```

Generate managed names and labels, default target `/data/<logical-name>`, refuse duplicate targets per Agent, and require confirmation before removing the declaration.

- [ ] **Step 4: Run frontend tests**

Run: `npx vitest run src/components/mounts src/lib/project-resources && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mounts src/lib/project-resources src/components/ResourcePanel.svelte
git commit -m "feat(resources): add data mounts caches and shares"
```

### Task 4: Safe Volume deletion orchestration

**Files:**
- Create: `src/lib/project-resources/delete-volume.ts`
- Create: `src/lib/project-resources/delete-volume.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Assert apply happens before remove, remove is never called when apply fails, and remove failure returns `detached_pending_cleanup` without restoring YAML mounts.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/lib/project-resources/delete-volume.test.ts`

Expected: FAIL for missing function.

- [ ] **Step 3: Implement explicit state result**

```ts
export type DeleteVolumeResult =
  | { status: 'removed' }
  | { status: 'detached_pending_cleanup'; error: string };
export async function deleteManagedVolume(input: DeleteManagedVolumeInput): Promise<DeleteVolumeResult>;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/project-resources/delete-volume.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-resources/delete-volume.ts src/lib/project-resources/delete-volume.test.ts
git commit -m "feat(resources): orchestrate safe volume deletion"
```
