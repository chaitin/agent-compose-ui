# Local Volume Files Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable volume file access in the host-process development topology and make unavailable or missing volumes explicit and non-mutable in the browser.

**Architecture:** The development supervisor passes the daemon's narrow local-volume root only to the UI gateway; the gateway's existing resolver remains the security boundary. The Svelte browser records whether the last list request succeeded, found no physical volume, or reached a disabled service, and derives mutation availability and empty-state rendering from that result.

**Tech Stack:** Bun/Node development supervisor, Svelte 5, TypeScript, Vitest and Testing Library, Go UI gateway configuration.

---

### Task 1: Supply the development volume root to the UI gateway

**Files:**
- Modify: `scripts/dev.test.mjs`
- Modify: `scripts/dev.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write the failing supervisor contract test**

Add `localVolumeRoot: '/data/volumes/local'` to the configured-paths test input in `scripts/dev.test.mjs`, then assert:

```js
expect(specs[0].env.LOCAL_VOLUME_ROOT).toBe('/data/volumes/local');
expect(specs[1].env.LOCAL_VOLUME_ROOT).toBeUndefined();
expect(specs[2].env.LOCAL_VOLUME_ROOT).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test scripts/dev.test.mjs`

Expected: FAIL because `specs[0].env.LOCAL_VOLUME_ROOT` is undefined.

- [ ] **Step 3: Pass the restricted root to the gateway**

Extend `childSpecs` with a `localVolumeRoot` input and add it conditionally only to `gatewayEnv`:

```js
export function childSpecs({
  executable,
  gatewayExecutable = 'go',
  token,
  authMode = 'disabled',
  agentComposeURL = '',
  scriptServiceURL = '',
  agentComposeDBPath = '',
  uiStateDBPath = '',
  localVolumeRoot = '',
  goCache = '',
  goModCache = '',
}) {
  // existing setup
  const gatewayEnv = {
    ...env,
    AUTH_MODE: authMode,
    ...(localVolumeRoot ? { LOCAL_VOLUME_ROOT: localVolumeRoot } : {}),
    // existing conditional values
  };
}
```

In `startDevelopment`, supply an explicit override or the daemon development root:

```js
localVolumeRoot: process.env.LOCAL_VOLUME_ROOT ||
  path.resolve(projectRoot, '../agent-compose/.dev-data/volumes/local'),
```

Do not add a default inside the Go gateway; non-development deployments remain fail-closed.

- [ ] **Step 4: Document the development default and override**

Update the `bun run dev` paragraph in `README.md` to state that the supervisor passes `../agent-compose/.dev-data/volumes/local` as `LOCAL_VOLUME_ROOT` to the gateway only, and that an alternate daemon data root requires an explicit absolute `LOCAL_VOLUME_ROOT`.

Update the split-terminal example so the gateway command is:

```bash
LOCAL_VOLUME_ROOT=/absolute/path/to/agent-compose-data/volumes/local bun run dev:gateway
```

- [ ] **Step 5: Verify GREEN**

Run: `bun test scripts/dev.test.mjs`

Expected: all tests pass.

- [ ] **Step 6: Commit the supervisor fix**

```bash
git add scripts/dev.mjs scripts/dev.test.mjs README.md
git commit -m "fix(dev): enable managed volume file access"
```

### Task 2: Render unavailable and missing volume states safely

**Files:**
- Modify: `src/components/mounts/VolumeFileBrowser.component.test.ts`
- Modify: `src/components/mounts/VolumeFileBrowser.svelte`

- [ ] **Step 1: Write failing unavailable-state tests**

Import `VolumeFileApiError` normally and add a test whose first list rejects with
`new VolumeFileApiError(503, 'unavailable', 'volume files unavailable')`. Assert:

```ts
expect(await screen.findByRole('alert')).toHaveTextContent('卷文件服务未配置');
expect(screen.queryByText('目录为空')).not.toBeInTheDocument();
expect(screen.getByLabelText('新建文件夹')).toBeDisabled();
expect(screen.getByRole('button', { name: '创建文件夹' })).toBeDisabled();
expect(screen.getByLabelText('上传文件')).toBeDisabled();
expect(screen.getByRole('button', { name: '重新加载' })).toBeEnabled();
```

Have the next list call resolve with `[file]`, click reload, and assert `a.txt` appears and the mutation controls become enabled.

- [ ] **Step 2: Write the failing missing-volume test**

Reject list with `new VolumeFileApiError(404, 'not_found', 'volume not found')` and assert the alert contains `卷尚未创建` and `请先应用项目`, the false empty state is absent, and mutation controls are disabled.

- [ ] **Step 3: Run focused component tests and verify RED**

Run: `bunx vitest run src/components/mounts/VolumeFileBrowser.component.test.ts`

Expected: the new assertions fail because raw English messages are rendered, controls remain enabled, and `目录为空` is shown after errors.

- [ ] **Step 4: Add classified list state**

In `VolumeFileBrowser.svelte`, add:

```ts
type Availability = 'pending' | 'ready' | 'unavailable' | 'missing';
let availability = $state<Availability>('pending');
const mutationsDisabled = $derived(
  mutationBusy || dirty || availability !== 'ready',
);
```

Add a list-error classifier:

```ts
function listFailure(value: unknown): { availability: Availability; message: string } {
  if (value instanceof VolumeFileApiError && value.status === 503 && value.code === 'unavailable') {
    return { availability: 'unavailable', message: '卷文件服务未配置，配置后可重新加载。' };
  }
  if (value instanceof VolumeFileApiError && value.status === 404 && value.code === 'not_found') {
    return { availability: 'missing', message: '卷尚未创建，请先应用项目后重新加载。' };
  }
  return { availability: 'pending', message: message(value) };
}
```

At the start of `load`, set `availability = 'pending'`. On active success set it to `ready`; on active non-abort failure assign both classified fields. Clear `entries` when starting a new identity/load so stale entries cannot remain actionable after a failed refresh.

- [ ] **Step 5: Derive control and empty-state rendering**

Keep reload enabled unless a request or mutation is currently active:

```svelte
<button disabled={mutationBusy || loading}>重新加载</button>
```

Use `mutationsDisabled` for folder input, create button, upload input, entry open/delete controls, and save/delete confirmation actions. Render the empty message only after a successful list:

```svelte
{#if !loading && availability === 'ready' && entries.length === 0}
  <p>目录为空</p>
{/if}
```

Reset `availability` to `pending` on project/volume identity changes.

- [ ] **Step 6: Run focused component tests and verify GREEN**

Run: `bunx vitest run src/components/mounts/VolumeFileBrowser.component.test.ts`

Expected: all component tests pass.

- [ ] **Step 7: Commit the browser-state fix**

```bash
git add src/components/mounts/VolumeFileBrowser.svelte src/components/mounts/VolumeFileBrowser.component.test.ts
git commit -m "fix(volumes): expose unavailable file service states"
```

### Task 3: Verify the complete UI-side fix

**Files:**
- Test only; no production files expected.

- [ ] **Step 1: Run supervisor and volume-browser tests together**

Run:

```bash
bun test scripts/dev.test.mjs
bunx vitest run src/components/mounts/VolumeFileBrowser.component.test.ts src/components/mounts/DataMountPanel.component.test.ts
```

Expected: all tests pass without warnings or unhandled rejections.

- [ ] **Step 2: Run static Svelte checks**

Run: `bun run check`

Expected: zero errors.

- [ ] **Step 3: Run existing UI gateway volume tests**

Run: `go test ./internal/volumefiles ./internal/app -count=1`

Expected: both packages pass, proving the unchanged fail-closed gateway and resolver contracts remain intact.

- [ ] **Step 4: Confirm scope and working-tree integrity**

Run:

```bash
git status --short
git diff --check
git diff HEAD~2 -- scripts/dev.mjs scripts/dev.test.mjs README.md src/components/mounts/VolumeFileBrowser.svelte src/components/mounts/VolumeFileBrowser.component.test.ts
```

Expected: only the planned UI-side files differ in the two implementation commits; pre-existing unrelated working-tree changes remain untouched.
