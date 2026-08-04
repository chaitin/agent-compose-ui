# Volume File Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wrapping volume-file toolbar form with two compact icon actions and a script-style create-folder modal.

**Architecture:** A focused modal component owns folder-name presentation, validation, and dialog keyboard behavior. `VolumeFileBrowser` owns action availability, API mutations, hidden native file selection, and automatic directory refreshes.

**Tech Stack:** Svelte 5, TypeScript, inline SVG icons, Vitest, Testing Library, shared command-modal CSS classes.

---

### Task 1: Build the script-style folder creation modal

**Files:**
- Create: `src/components/mounts/VolumeFolderCreateModal.svelte`
- Create: `src/components/mounts/VolumeFolderCreateModal.component.test.ts`

- [ ] **Step 1: Write failing modal behavior tests**

Create `VolumeFolderCreateModal.component.test.ts` with a shared render helper and these observable assertions:

```ts
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import VolumeFolderCreateModal from './VolumeFolderCreateModal.svelte';

function setup(overrides = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(VolumeFolderCreateModal, { value: '', busy: false, onValue: vi.fn(), onSubmit, onClose, ...overrides });
  return { onSubmit, onClose };
}

test('uses the script command-modal layout and disables blank submission', () => {
  setup();
  expect(screen.getByRole('dialog', { name: '新建文件夹' })).toBeInTheDocument();
  expect(screen.getByText('VOLUME / CREATE')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
});

test('submits a trimmed name through the form and closes with Escape', async () => {
  const onValue = vi.fn();
  const { onSubmit, onClose } = setup({ value: ' docs ', onValue });
  await fireEvent.submit(screen.getByRole('form', { name: '新建文件夹表单' }));
  expect(onSubmit).toHaveBeenCalledWith('docs');
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});

test('does not dismiss while busy', async () => {
  const { onClose } = setup({ value: 'docs', busy: true });
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onClose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the modal test and verify RED**

Run: `bunx vitest run src/components/mounts/VolumeFolderCreateModal.component.test.ts`

Expected: FAIL because `VolumeFolderCreateModal.svelte` does not exist.

- [ ] **Step 3: Implement the modal component**

Create `VolumeFolderCreateModal.svelte` with this public boundary:

```ts
interface Props {
  value: string;
  busy: boolean;
  onValue: (value: string) => void;
  onSubmit: (name: string) => void;
  onClose: () => void;
}
```

Render a `resource-modal-backdrop modal-backdrop` and a
`resource-modal-card command-modal modal-card` dialog. Inside it, render a form with
`aria-label="新建文件夹表单"`, a command header containing `新建文件夹` and
`VOLUME / CREATE`, one `目录名` input, and the standard `command-footer` cancel and
primary create buttons. Submit `value.trim()` only when non-empty. Escape and backdrop
click call `onClose` only when `busy` is false. Add `autofocus` to the name input and
disable all form controls while busy.

Use the same modal width, typography, input treatment, footer alignment, and z-index as
`ScriptCreateModal.svelte`; do not add component-specific API calls.

- [ ] **Step 4: Run the modal tests and verify GREEN**

Run: `bunx vitest run src/components/mounts/VolumeFolderCreateModal.component.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Commit the modal component**

```bash
git add src/components/mounts/VolumeFolderCreateModal.svelte src/components/mounts/VolumeFolderCreateModal.component.test.ts
git commit -m "feat(volumes): add folder creation modal"
```

### Task 2: Replace toolbar controls with icon actions

**Files:**
- Modify: `src/components/mounts/VolumeFileBrowser.component.test.ts`
- Modify: `src/components/mounts/VolumeFileBrowser.svelte`

- [ ] **Step 1: Replace toolbar expectations with failing icon-layout tests**

Update the existing toolbar test to assert:

```ts
const toolbar = screen.getByRole('toolbar', { name: '卷文件操作' });
expect(within(toolbar).getByRole('button', { name: '新建文件夹' })).toBeInTheDocument();
expect(within(toolbar).getByRole('button', { name: '上传文件' })).toBeInTheDocument();
expect(within(toolbar).queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument();
expect(within(toolbar).queryByLabelText('新建文件夹')).not.toBeInTheDocument();
```

Add a test that clicks the create icon, enters `docs` in the modal, submits, and asserts
the existing call contract:

```ts
expect(volumeFileApi.mkdir).toHaveBeenCalledWith(KEY_A, 'managed', 'docs', expect.any(AbortSignal));
await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建文件夹' })).not.toBeInTheDocument());
```

Change failed-folder expectations to assert the modal and entered value remain after
`mkdir` rejects.

- [ ] **Step 2: Run browser tests and verify RED**

Run: `bunx vitest run src/components/mounts/VolumeFileBrowser.component.test.ts`

Expected: FAIL because the toolbar still contains reload and inline controls and does
not open a modal.

- [ ] **Step 3: Integrate the modal and icon actions**

Import `VolumeFolderCreateModal`. Add `folderDialog = $state(false)` while retaining
`folderName`. Change folder creation to accept the submitted name and close only after
successful mutation:

```ts
async function createFolder(name: string) {
  folderName = name;
  if (await mutate((signal) => volumeFileApi.mkdir(projectKey, volume, join(path, name), signal))) {
    folderName = '';
    folderDialog = false;
  }
}
```

Reset `folderDialog` and `folderName` when project or volume identity changes.

Replace the toolbar body with a non-wrapping title and action group. The create button
has `aria-label` and `title` set to `新建文件夹`; its inline SVG is a folder outline with
a plus mark. The upload button has `aria-label` and `title` set to `上传文件`; its inline
SVG is an upward arrow entering a tray. Both use `type="button"`, the existing ghost
button visual language, and `disabled={mutationsDisabled}`.

Place this visually hidden input after the upload button:

```svelte
<input class="visually-hidden-file" disabled={mutationsDisabled} type="file" aria-label="选择上传文件" onchange={upload} />
```

Associate the upload icon with the input using a bound element and `.click()`, so its
accessible action remains a real button. Remove the reload button, visible upload label,
and inline folder form.

Render the modal after the browser section:

```svelte
{#if folderDialog}
  <VolumeFolderCreateModal
    value={folderName}
    busy={mutationBusy}
    onValue={(value) => { folderName = value; }}
    onSubmit={(name) => { void createFolder(name); }}
    onClose={() => { if (!mutationBusy) folderDialog = false; }}
  />
{/if}
```

Add focused toolbar CSS: `flex-wrap:nowrap`, `.toolbar-actions`, 30–32px square icon
buttons, 16px SVGs with currentColor strokes, and a clipped hidden file input. Remove
the obsolete `.toolbar form,.toolbar label` rule.

- [ ] **Step 4: Update unavailable-state recovery expectations**

Since explicit reload is intentionally removed, change the 503 test to assert both icon
actions are disabled and no reload button exists. Keep recovery coverage through a
project/volume rerender whose next list call succeeds, then assert both actions become
enabled.

- [ ] **Step 5: Run browser tests and verify GREEN**

Run: `bunx vitest run src/components/mounts/VolumeFileBrowser.component.test.ts`

Expected: all browser tests pass.

- [ ] **Step 6: Commit toolbar integration**

```bash
git add src/components/mounts/VolumeFileBrowser.svelte src/components/mounts/VolumeFileBrowser.component.test.ts
git commit -m "feat(volumes): compact file browser actions"
```

### Task 3: Verify the UI change

**Files:**
- Test only; no production files expected.

- [ ] **Step 1: Run focused component suites**

Run:

```bash
bunx vitest run src/components/mounts/VolumeFolderCreateModal.component.test.ts src/components/mounts/VolumeFileBrowser.component.test.ts src/components/mounts/DataMountPanel.component.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run Svelte static checks**

Run: `bun run check`

Expected: 0 errors and 0 warnings.

- [ ] **Step 3: Check formatting and scope**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing working-tree changes remain
untouched.
