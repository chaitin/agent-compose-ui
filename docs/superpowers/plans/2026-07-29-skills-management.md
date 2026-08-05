# Skills Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage valid project-local Skills in shared project storage and link them to Agents through standard YAML.

**Architecture:** A focused Go project-files API scopes every operation to `<PROJECT_STORAGE_ROOT>/<project-key>/skills`. The Svelte Skill panel uses this API and the lossless YAML mutations from the foundation plan.

**Tech Stack:** Go `net/http`/`os.Root`, Svelte 5, TypeScript, Vitest, Go test.

---

**Hard boundary:** Every changed file must be inside `agent-compose-ui`. Do not add a daemon Skill API or modify daemon Skill resolution; the Go gateway and shared project directory must provide all new behavior.

### Task 1: General project resource storage

**Files:**
- Create: `internal/projectfiles/storage.go`
- Create: `internal/projectfiles/storage_test.go`
- Create: `internal/projectfiles/model.go`

- [ ] **Step 1: Write failing storage tests**

Cover list, read, atomic write, upload, download lookup, mkdir, delete, traversal, absolute paths, control characters, symlink parents, and maximum file size.

```go
_, err := store.Write("ws_0123456789abcdef0123456789abcdef", "skills", "review/SKILL.md", []byte("ok"), "")
if err != nil { t.Fatal(err) }
```

- [ ] **Step 2: Verify failure**

Run: `go test ./internal/projectfiles -run TestStorage -count=1`

Expected: FAIL because package does not exist.

- [ ] **Step 3: Implement scoped storage**

```go
type Storage struct { ProjectRoot string; MaxFileBytes int64 }
func (s *Storage) List(projectKey, resource, relative string) ([]Entry, error)
func (s *Storage) Read(projectKey, resource, relative string) (File, error)
func (s *Storage) Write(projectKey, resource, relative string, body []byte, expectedSHA256 string) (File, error)
func (s *Storage) Mkdir(projectKey, resource, relative string) error
func (s *Storage) Remove(projectKey, resource, relative string, recursive bool) error
```

Allow only resource `skills`; reuse localfs project-key validation behavior, reject symlinks, and write via same-directory temporary file plus rename.

- [ ] **Step 4: Run package tests**

Run: `go test ./internal/projectfiles -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/projectfiles
git commit -m "feat(skills): add scoped project file storage"
```

### Task 2: Skill HTTP API and valid template

**Files:**
- Create: `internal/projectfiles/handler.go`
- Create: `internal/projectfiles/handler_test.go`
- Modify: `internal/app/server.go`
- Modify: `internal/app/server_test.go`

- [ ] **Step 1: Write failing API tests**

Test `/api/project-files/skills`, `/file`, `/folder`, `/upload`, and `/download`. Test `POST /api/project-files/skills/create` writes:

```markdown
---
name: security-review
description: 请填写 Skill 的用途
---

请在这里编写 Skill 指令。
```

- [ ] **Step 2: Verify failure**

Run: `go test ./internal/projectfiles ./internal/app -count=1`

Expected: FAIL with 404/missing handler.

- [ ] **Step 3: Implement routes and registration**

```go
type CreateSkillRequest struct { ProjectKey string `json:"projectKey"`; Name string `json:"name"` }
```

Validate names with `^[a-z][a-z0-9_-]*$`, return 409 on existing Skill, apply `http.MaxBytesReader`, and register the authenticated handler before daemon proxy routing.

- [ ] **Step 4: Run Go tests**

Run: `go test ./internal/projectfiles ./internal/app ./internal/localfs -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/projectfiles internal/app/server.go internal/app/server_test.go
git commit -m "feat(skills): expose managed skill file API"
```

### Task 3: Skill client and panel

**Files:**
- Create: `src/lib/skills/api.ts`
- Create: `src/lib/skills/api.test.ts`
- Create: `src/lib/skills/references.ts`
- Create: `src/lib/skills/references.test.ts`
- Create: `src/components/skills/SkillPanel.svelte`
- Create: `src/components/skills/SkillPanel.component.test.ts`
- Modify: `src/components/ResourcePanel.svelte`

- [ ] **Step 1: Write failing API, reference, and component tests**

Assert creation calls the Go API, then invokes YAML change with the selected Agent. Assert deletion shows every referencing Agent before deleting files and YAML entries.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/lib/skills src/components/skills`

Expected: FAIL because modules are absent.

- [ ] **Step 3: Implement the API and Skill panel**

```ts
export const skillApi = {
  list(projectKey: string): Promise<Entry[]>,
  create(projectKey: string, name: string): Promise<FileEntry>,
  read(projectKey: string, path: string): Promise<FileContent>,
  write(projectKey: string, path: string, content: string, expectedSHA256: string): Promise<FileContent>,
  remove(projectKey: string, path: string, recursive: boolean): Promise<void>,
};
```

Use an explicit `onYamlChange(nextYaml)` prop. Do not import or mutate the global editor store from the panel.

- [ ] **Step 4: Run frontend tests and checks**

Run: `npx vitest run src/lib/skills src/components/skills src/components/ResourcePanel.component.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills src/components/skills src/components/ResourcePanel.svelte
git commit -m "feat(skills): add project Skill management"
```
