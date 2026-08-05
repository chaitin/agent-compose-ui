# Skills and Mounts UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign only the frontend Skills and data/mounts panels to match the existing Scripts and Workspace interaction model while using only currently available backend APIs.

**Architecture:** Keep all YAML mutation, API, deletion, and concurrency logic in the existing frontend modules. Split visual responsibilities into focused list, detail, toolbar, and modal components; `SkillPanel` and `DataMountPanel` remain state coordinators. No Go, protobuf, daemon, deployment, or server routing file may change.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Testing Library, existing ConnectRPC clients and HTTP APIs.

---

## Immutable backend capability boundary

The implementation may call only these existing contracts:

| Capability | Existing frontend/backend contract | Allowed UI behavior |
| --- | --- | --- |
| Skill list/read/write/delete | `skillApi` over `/api/project-files/*` | List and edit `SKILL.md`, delete with existing reference workflow |
| Skill file upload | Existing `/api/project-files/upload` multipart endpoint | Upload one UTF-8 `SKILL.md` to `<skill>/SKILL.md` |
| Skill directory creation | Existing `/api/project-files/folder` | Create upload target before sending the file |
| Skill ZIP/directory import | No extraction/import endpoint | Not implemented and no visible control |
| Data volume/cache mounts | Existing YAML mutation functions | Create declarations and mounts by editing YAML only |
| Shared directories | `sharedDirectoryApi.list()` | Select only server-approved directories |
| Physical volume removal | Existing `volumeService.removeVolume` | Preserve current apply-before-delete safeguards |
| Volume files | Existing `volumeFileApi` | List, preview, edit, upload, mkdir, download, and delete |

Hard rule: a diff under `internal/`, `cmd/`, `proto/`, `docker/`, `script-service/`, or sibling `agent-compose/` fails scope review.

## File map

- `src/components/skills/SkillPanel.svelte`: Skill state and operation coordination.
- `src/components/skills/SkillToolbar.svelte`: New/upload/refresh actions.
- `src/components/skills/SkillList.svelte`: File-tree-like Skill navigation.
- `src/components/skills/SkillEditor.svelte`: Header, dirty state, content editor, save/delete actions.
- `src/components/skills/SkillCreateModal.svelte`: Existing create flow in a modal.
- `src/components/skills/SkillUploadModal.svelte`: Single `SKILL.md` upload flow.
- `src/lib/skills/api.ts`: Add frontend wrappers for existing mkdir/upload contracts only.
- `src/components/mounts/DataMountPanel.svelte`: Resource selection and lifecycle coordination.
- `src/components/mounts/MountResourceList.svelte`: Grouped left navigation.
- `src/components/mounts/MountResourceDetail.svelte`: Selected resource details and actions.
- `src/components/mounts/CreateVolumeModal.svelte`: Create managed volume UI.
- `src/components/mounts/MountResourceModal.svelte`: Existing volume/cache/share mount UI.
- `src/components/mounts/VolumeFileBrowser.svelte`: Workspace-style file layout using unchanged API.

### Task 1: Lock frontend-only scope and expose existing Skill upload APIs

**Files:**
- Modify: `src/lib/skills/api.ts`
- Modify: `src/lib/skills/api.test.ts`

- [ ] **Step 1: Write failing API tests**

Add tests proving the client calls the already-existing endpoints exactly:

```ts
test('creates a skill folder and uploads one SKILL.md', async () => {
  await skillApi.mkdir('ws_1', 'review');
  await skillApi.upload('ws_1', 'review/SKILL.md', new File(['body'], 'SKILL.md'));
  expect(fetch.mock.calls[0]).toEqual(['/api/project-files/folder', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ projectKey: 'ws_1', path: 'review' }),
  })]);
  expect(fetch.mock.calls[1][0]).toBe('/api/project-files/upload');
  expect(fetch.mock.calls[1][1].body).toBeInstanceOf(FormData);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bunx vitest run src/lib/skills/api.test.ts`

Expected: FAIL because `mkdir` and `upload` are absent.

- [ ] **Step 3: Add minimal wrappers**

Implement only:

```ts
async mkdir(projectKey: string, path: string): Promise<void> {
  await request('/folder', { method: 'POST', body: JSON.stringify({ projectKey, path }) });
},
async upload(projectKey: string, path: string, file: File): Promise<FileEntry> {
  const body = new FormData();
  body.set('projectKey', projectKey);
  body.set('path', path);
  body.set('file', file);
  const payload = await request('/upload', { method: 'POST', body });
  const uploaded = envelopeField(payload, 'file');
  if (!validFileEntry(uploaded)) invalidResponse(payload.status);
  return uploaded;
},
```

Adjust `request` so it adds JSON `content-type` only when `body` is not `FormData`; do not change endpoint paths or response validation.

- [ ] **Step 4: Verify GREEN and scope**

Run: `bunx vitest run src/lib/skills/api.test.ts && git diff --check`

Expected: all tests PASS and the diff contains only the two listed frontend files.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/api.ts src/lib/skills/api.test.ts
git commit -m "feat(skills): expose existing file upload API"
```

### Task 2: Build the Skill file-management shell

**Files:**
- Create: `src/components/skills/SkillToolbar.svelte`
- Create: `src/components/skills/SkillList.svelte`
- Create: `src/components/skills/SkillEditor.svelte`
- Modify: `src/components/skills/SkillPanel.svelte`
- Modify: `src/components/skills/SkillPanel.component.test.ts`

- [ ] **Step 1: Write failing layout and navigation tests**

Add assertions for a toolbar, left navigation, right editor, selected item, refresh, and unchanged save/delete callbacks:

```ts
expect(screen.getByRole('toolbar', { name: 'Skill 操作' })).toBeInTheDocument();
expect(screen.getByRole('navigation', { name: 'Skills 列表' })).toBeInTheDocument();
expect(screen.getByRole('region', { name: 'Skill 编辑器' })).toBeInTheDocument();
await user.click(screen.getByRole('button', { name: 'review' }));
expect(screen.getByRole('textbox', { name: 'SKILL.md 内容' })).toHaveValue(expect.stringContaining('name: review'));
```

Also assert that switching away from a dirty Skill opens a confirmation dialog and does not issue a backend call until confirmed.

- [ ] **Step 2: Run the component test and verify RED**

Run: `bunx vitest run src/components/skills/SkillPanel.component.test.ts`

Expected: FAIL because the toolbar/regions and dirty-navigation confirmation do not exist.

- [ ] **Step 3: Extract presentational components**

Use callback-only component APIs:

```ts
// SkillToolbar.svelte props
interface Props { busy: boolean; onCreate: () => void; onUpload: () => void; onRefresh: () => void }

// SkillList.svelte props
interface Props { entries: Entry[]; selected: string; loading: boolean; error: string; onSelect: (name: string) => void; onRetry: () => void }

// SkillEditor.svelte props
interface Props {
  name: string; content: string; dirty: boolean; busy: boolean; conflict: boolean;
  references: number; onContent: (value: string) => void; onSave: () => void;
  onDelete: () => void; onReload: () => void;
}
```

Keep API calls, generations, deletion phases, and rollback logic in `SkillPanel.svelte`. Add a captured pending selection and confirmation dialog for dirty navigation.

- [ ] **Step 4: Run tests and checks**

Run: `bunx vitest run src/components/skills/SkillPanel.component.test.ts src/lib/skills && bun run check`

Expected: PASS with zero Svelte diagnostics.

- [ ] **Step 5: Commit**

```bash
git add src/components/skills
git commit -m "refactor(skills): align panel with file management UI"
```

### Task 3: Move Skill create and upload into focused modals

**Files:**
- Create: `src/components/skills/SkillCreateModal.svelte`
- Create: `src/components/skills/SkillUploadModal.svelte`
- Modify: `src/components/skills/SkillPanel.svelte`
- Modify: `src/components/skills/SkillPanel.component.test.ts`

- [ ] **Step 1: Write failing modal workflow tests**

Cover create, upload, validation, rollback, focus, and unsupported formats:

```ts
await user.click(screen.getByRole('button', { name: '上传 Skill' }));
expect(screen.getByRole('dialog', { name: '上传 Skill' })).toBeInTheDocument();
const input = screen.getByLabelText('选择 SKILL.md');
await user.upload(input, new File(['---\nname: review\ndescription: review\n---\n'], 'SKILL.md', { type: 'text/markdown' }));
await user.click(screen.getByRole('button', { name: '确认上传' }));
expect(skillApi.mkdir).toHaveBeenCalledWith(projectKey, 'review');
expect(skillApi.upload).toHaveBeenCalledWith(projectKey, 'review/SKILL.md', expect.any(File));
expect(onYamlChange).toHaveBeenCalled();
```

Assert `.zip`, non-UTF-8, wrong filename, and invalid Skill names are rejected before API calls. Assert Escape closes an idle dialog and returns focus to the triggering button.

- [ ] **Step 2: Run the test and verify RED**

Run: `bunx vitest run src/components/skills/SkillPanel.component.test.ts`

Expected: FAIL because the modal workflows are absent.

- [ ] **Step 3: Implement minimal modal workflows**

Create modal components with values returned through callbacks. In `SkillPanel`, upload in this order:

```ts
await skillApi.mkdir(projectKey, name);
try {
  await skillApi.upload(projectKey, `${name}/SKILL.md`, file);
  await onYamlChange(upsertAgentSkill(yaml, agent, {
    name, source: 'file', path: `./skills/${name}`,
  }));
} catch (error) {
  await skillApi.remove(projectKey, name, true).catch(() => undefined);
  throw error;
}
```

Do not parse ZIP, create archive controls, or add server assumptions.

- [ ] **Step 4: Verify workflows**

Run: `bunx vitest run src/components/skills src/lib/skills && bun run check`

Expected: PASS; upload uses existing endpoints only.

- [ ] **Step 5: Commit**

```bash
git add src/components/skills
git commit -m "feat(skills): add supported SKILL.md upload flow"
```

### Task 4: Build grouped data/mount navigation and details

**Files:**
- Create: `src/components/mounts/MountResourceList.svelte`
- Create: `src/components/mounts/MountResourceDetail.svelte`
- Modify: `src/components/mounts/DataMountPanel.svelte`
- Modify: `src/components/mounts/DataMountPanel.component.test.ts`

- [ ] **Step 1: Write failing grouped-navigation tests**

Assert the left side has three groups and the right side reflects selection:

```ts
expect(screen.getByRole('navigation', { name: '数据资源' })).toBeInTheDocument();
expect(screen.getByRole('group', { name: '持久数据' })).toBeInTheDocument();
expect(screen.getByRole('group', { name: '依赖缓存' })).toBeInTheDocument();
expect(screen.getByRole('group', { name: '共享目录' })).toBeInTheDocument();
await user.click(screen.getByRole('button', { name: /project-memory/ }));
expect(screen.getByRole('region', { name: 'project-memory 详情' })).toHaveTextContent('/data/project-memory');
```

Retain existing assertions for unmount, two-phase removal, re-declaration guards, failed cleanup retry, and stale project isolation.

- [ ] **Step 2: Run and verify RED**

Run: `bunx vitest run src/components/mounts/DataMountPanel.component.test.ts`

Expected: FAIL for missing navigation/detail semantics.

- [ ] **Step 3: Extract list and detail views**

Define a frontend-only selection union:

```ts
export type MountSelection =
  | { kind: 'volume'; key: string }
  | { kind: 'cache'; key: string; agent: string }
  | { kind: 'share'; source: string; agent: string; target: string };
```

`MountResourceList` renders grouped buttons. `MountResourceDetail` receives derived resources and callbacks; it must not call APIs or mutate YAML. `DataMountPanel` retains all operation state and existing safety functions.

- [ ] **Step 4: Verify GREEN**

Run: `bunx vitest run src/components/mounts/DataMountPanel.component.test.ts src/lib/project-resources && bun run check`

Expected: PASS and no existing deletion-safety assertion changes.

- [ ] **Step 5: Commit**

```bash
git add src/components/mounts
git commit -m "refactor(mounts): add grouped resource navigation"
```

### Task 5: Move create and mount forms into supported modals

**Files:**
- Create: `src/components/mounts/CreateVolumeModal.svelte`
- Create: `src/components/mounts/MountResourceModal.svelte`
- Modify: `src/components/mounts/DataMountPanel.svelte`
- Modify: `src/components/mounts/DataMountPanel.component.test.ts`

- [ ] **Step 1: Write failing modal tests**

Cover the toolbar and conditional fields:

```ts
expect(screen.getByRole('toolbar', { name: '数据与挂载操作' })).toBeInTheDocument();
await user.click(screen.getByRole('button', { name: '挂载资源' }));
await user.selectOptions(screen.getByLabelText('资源类型'), 'cache');
expect(screen.getByLabelText('缓存预设')).toBeInTheDocument();
expect(screen.queryByLabelText('共享目录')).not.toBeInTheDocument();
```

Assert volume mode shows existing volume/Agent/target; cache mode shows Agent/preset; share mode shows approved server directory/Agent/target/read-only. Assert a read-only catalog entry disables writable mode.

- [ ] **Step 2: Run and verify RED**

Run: `bunx vitest run src/components/mounts/DataMountPanel.component.test.ts`

Expected: FAIL because the persistent forms are still rendered.

- [ ] **Step 3: Implement modal presentation**

Move only form state and rendering. Submit callbacks must call the existing coordinator methods:

```ts
type MountDraft =
  | { kind: 'volume'; volume: string; agent: string; target: string }
  | { kind: 'cache'; preset: keyof typeof CACHE_PRESETS; agent: string }
  | { kind: 'share'; directoryId: string; agent: string; target: string; readOnly: boolean };
```

Do not add API calls. Keep `managedVolumeName`, `upsertProjectVolume`, `upsertAgentMount`, `sharedDirectoryApi.list`, and duplicate-target checks unchanged.

- [ ] **Step 4: Run tests and checks**

Run: `bunx vitest run src/components/mounts/DataMountPanel.component.test.ts src/lib/project-resources && bun run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mounts
git commit -m "refactor(mounts): move creation flows into modals"
```

### Task 6: Align Volume file browsing with Workspace

**Files:**
- Modify: `src/components/mounts/VolumeFileBrowser.svelte`
- Modify: `src/components/mounts/VolumeFileBrowser.component.test.ts`

- [ ] **Step 1: Write failing layout tests**

Assert a local toolbar and two-pane file experience while preserving operations:

```ts
expect(screen.getByRole('toolbar', { name: '卷文件操作' })).toBeInTheDocument();
expect(screen.getByRole('navigation', { name: '卷文件列表' })).toBeInTheDocument();
expect(screen.getByRole('region', { name: '卷文件预览' })).toBeInTheDocument();
```

Keep tests for dirty confirmation, stale responses, CAS conflict, serialized mutations, upload, mkdir, download URL, and delete confirmation.

- [ ] **Step 2: Run and verify RED**

Run: `bunx vitest run src/components/mounts/VolumeFileBrowser.component.test.ts`

Expected: FAIL only for missing layout semantics.

- [ ] **Step 3: Reorganize existing controls**

Render reload, upload, and mkdir in a local toolbar; render entries in a fixed left pane and preview/editor in a flexible right pane. Reuse every existing `volumeFileApi` call and concurrency guard unchanged.

- [ ] **Step 4: Verify GREEN**

Run: `bunx vitest run src/components/mounts/VolumeFileBrowser.component.test.ts src/lib/volume-files && bun run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mounts/VolumeFileBrowser.svelte src/components/mounts/VolumeFileBrowser.component.test.ts
git commit -m "refactor(volumes): align file browser with workspace"
```

### Task 7: Frontend-only integration and regression gate

**Files:**
- Test: `src/components/skills/SkillPanel.component.test.ts`
- Test: `src/components/mounts/DataMountPanel.component.test.ts`
- Test: `src/components/mounts/VolumeFileBrowser.component.test.ts`

- [ ] **Step 1: Run the complete frontend feature suite**

Run:

```bash
bunx vitest run \
  src/components/skills \
  src/components/mounts \
  src/lib/skills \
  src/lib/volume-files \
  src/lib/project-resources
```

Expected: all tests PASS.

- [ ] **Step 2: Run static and production checks**

Run:

```bash
bun run check
bun run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Enforce the backend immutability boundary**

Run:

```bash
git diff --name-only a00c9d2..HEAD | rg '^(internal|cmd|proto|docker|script-service)/|^../agent-compose/'
```

Expected: no output. If any path is printed, stop and remove that change from this redesign before continuing.

- [ ] **Step 4: Manually verify the Vite UI**

Run: `bun run dev:web`

At `http://127.0.0.1:5174/`, verify:

- Skills has toolbar + left list + right editor and uploads only `SKILL.md`;
- data/mounts has grouped left resources + right details + modal creation flows;
- no ZIP upload control exists;
- no persistent creation forms remain in the main panels;
- Scripts and Workspace remain visually and functionally unchanged.

- [ ] **Step 5: Commit the verified frontend integration**

```bash
git add src/components/skills src/components/mounts
git commit -m "feat(resources): complete frontend resource UI redesign"
```
