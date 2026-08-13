# Repository Blue Color System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Agent Compose UI around the approved Repository Blue palette while changing colors only.

**Architecture:** Keep the existing component structure and CSS geometry intact. Define the complete semantic palette in `src/app.css`, replace component-private color literals with global tokens or token-derived `color-mix()` values, and audit the resulting patch against a pre-change snapshot so no non-color property changes enter the implementation.

**Tech Stack:** Svelte 5, CSS custom properties, Vite, Bun, Vitest, `svelte-check`

---

## File map

- `src/app.css`: owns global surface, text, brand, and semantic color tokens plus shared controls and modal colors.
- `src/components/**/*.svelte`: owns workbench, resource, editor, settings, and component-local state colors.
- `src/pages/**/*.svelte`: owns page-level list, session, dashboard, and status colors.
- `src/views/runtime/**/*.svelte`: owns runtime, timeline, sandbox, scheduler, and execution state colors.
- No markup, TypeScript behavior, layout, typography, size, spacing, radius, border-width, animation, or responsive rule may change.

### Task 1: Establish a color-only baseline and audit command

**Files:**
- Read: `src/app.css`
- Read: `src/**/*.svelte`
- Create outside repository: `/tmp/agent-compose-ui-repository-blue-baseline/src`

- [ ] **Step 1: Record the current dirty worktree and copy the source baseline**

Run:

```bash
git status --short
baseline_dir=/tmp/agent-compose-ui-repository-blue-baseline
mkdir -p "$baseline_dir"
cp -a src "$baseline_dir/src"
```

Expected: the existing user changes are listed; the baseline copy completes without modifying tracked files.

- [ ] **Step 2: Inventory every literal color before editing**

Run:

```bash
rg -n --glob '*.css' --glob '*.svelte' '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(' src > /tmp/repository-blue-colors-before.txt
wc -l /tmp/repository-blue-colors-before.txt
```

Expected: the inventory contains roughly 251 declarations and gives a fixed audit input.

- [ ] **Step 3: Confirm the protected-property list**

Use this exact list during every patch review:

```text
font font-family font-size font-weight line-height letter-spacing
width min-width max-width height min-height max-height
margin padding gap inset top right bottom left position
display grid grid-template grid-column grid-row flex align justify
border-width border-style border-radius
transform transition animation opacity filter backdrop-filter
```

Expected: no implementation diff changes a value belonging to any listed property.

### Task 2: Install the approved global Repository Blue tokens

**Files:**
- Modify: `src/app.css:1`

- [ ] **Step 1: Update only the values in the `:root` color token block**

Apply this exact color block while leaving typography and size tokens byte-for-byte unchanged:

```css
:root {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --border-color: #30363d;
  --text-primary: #f0f6fc;
  --text-secondary: #8b949e;
  --text-muted: #6e7681;
  --accent-blue: #1f6feb;
  --accent-blue-bright: #58a6ff;
  --accent-green: #3fb950;
  --accent-red: #f85149;
  --accent-yellow: #d29922;
  --accent-orange: #db6d28;
  --accent-purple: #a371f7;
}
```

Expected: the existing `--font-*`, `--font-size-*`, and `--sidebar-width` declarations remain unchanged.

- [ ] **Step 2: Normalize hard-coded shared modal and control colors**

In `src/app.css`, make these semantic replacements without changing any other declaration component:

```css
color: #dce7f2;       -> color: var(--text-primary);
background: #151b23;  -> background: var(--bg-secondary);
background: #11171e;  -> background: var(--bg-primary);
border-color: #303944; -> border-color: var(--border-color);
border-color: #29323d; -> border-color: var(--border-color);
color: #7d8b99;       -> color: var(--text-muted);
color: #8e9aa8;       -> color: var(--text-secondary);
background: #0c1117;  -> background: var(--bg-primary);
color: #9ccaff;       -> color: var(--accent-blue-bright);
color: #8bc5ff;       -> color: var(--accent-blue-bright);
color: #a8d6ff;       -> color: var(--accent-blue-bright);
```

For blue-tinted backgrounds and borders, use the existing backgrounds with `color-mix()`:

```css
border-color: color-mix(in srgb, var(--accent-blue) 55%, var(--border-color));
background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary));
```

Expected: shared buttons, inputs, and command modals use the same surface and brand system.

- [ ] **Step 3: Run static checks for the global-token patch**

Run:

```bash
bun run check
git diff --check -- src/app.css
```

Expected: `svelte-check found 0 errors and 0 warnings`; `git diff --check` prints nothing.

- [ ] **Step 4: Commit only the global palette**

```bash
git add src/app.css
git commit -m "style: establish repository blue palette"
```

Expected: one commit containing only color changes in `src/app.css`.

### Task 3: Normalize the core workbench colors

**Files:**
- Modify: `src/components/LoginView.svelte`
- Modify: `src/components/Resizer.svelte`
- Modify: `src/components/Sidebar.svelte`
- Modify: `src/components/StatusIndicator.svelte`
- Modify: `src/components/Toast.svelte`
- Modify: `src/components/Toolbar.svelte`
- Modify: `src/components/YamlEditor.svelte`

- [ ] **Step 1: Replace surface and text literals in the seven core components**

Use this exact mapping wherever the literal has the corresponding visual role:

```text
page/editor deepest background -> var(--bg-primary)
sidebar/panel/modal background  -> var(--bg-secondary)
card/input/hover background     -> var(--bg-tertiary)
default divider                 -> var(--border-color)
heading/body                    -> var(--text-primary)
description/label               -> var(--text-secondary)
placeholder/timestamp           -> var(--text-muted)
```

Do not change selector names, declaration order, or any non-color value.

- [ ] **Step 2: Normalize action and state colors in the core components**

Use this mapping:

```text
active navigation, primary action, focus, link -> var(--accent-blue)
small blue text on dark background             -> var(--accent-blue-bright)
connected, running, valid, success             -> var(--accent-green)
dirty, waiting, draft, warning                  -> var(--accent-yellow)
invalid, failed, delete, danger                 -> var(--accent-red)
```

Replace existing blue/green/red translucent fills with `color-mix(in srgb, <semantic-token> <existing-percentage>, transparent)` while preserving the original percentage.

- [ ] **Step 3: Verify core component tests**

Run:

```bash
bun test test/components/Sidebar.test.ts src/components/YamlEditor.test.js src/components/ToolbarScripts.test.js src/components/ToolbarImageBuild.test.js
bun run check
```

Expected: all selected tests pass and `svelte-check` reports no errors.

- [ ] **Step 4: Review the patch for protected properties and commit**

Run:

```bash
git diff --check
git diff -- src/components/LoginView.svelte src/components/Resizer.svelte src/components/Sidebar.svelte src/components/StatusIndicator.svelte src/components/Toast.svelte src/components/Toolbar.svelte src/components/YamlEditor.svelte
```

Expected: every changed line is a `color`, `background`, `border-color`, `outline`, `box-shadow`, `text-shadow`, `caret-color`, `accent-color`, or color custom-property value.

```bash
git add src/components/LoginView.svelte src/components/Resizer.svelte src/components/Sidebar.svelte src/components/StatusIndicator.svelte src/components/Toast.svelte src/components/Toolbar.svelte src/components/YamlEditor.svelte
git commit -m "style: unify core workbench colors"
```

### Task 4: Normalize resource-management colors

**Files:**
- Modify: `src/components/env/ConfigureGlobalEnvModal.svelte`
- Modify: `src/components/images/ImageBuildPanel.svelte`
- Modify: `src/components/mounts/DataMountPanel.svelte`
- Modify: `src/components/mounts/MountResourceDetail.svelte`
- Modify: `src/components/mounts/MountResourceList.svelte`
- Modify: `src/components/mounts/VolumeFileBrowser.svelte`
- Modify: `src/components/scripts/ScriptCreateModal.svelte`
- Modify: `src/components/scripts/ScriptEditor.svelte`
- Modify: `src/components/scripts/ScriptLineActions.svelte`
- Modify: `src/components/scripts/ScriptReferenceModal.svelte`
- Modify: `src/components/scripts/ScriptTree.svelte`
- Modify: `src/components/skills/SkillCreateModal.svelte`
- Modify: `src/components/skills/SkillList.svelte`
- Modify: `src/components/skills/SkillPanel.svelte`
- Modify: `src/components/skills/SkillUploadModal.svelte`
- Modify: `src/components/workspace/WorkspaceFileTree.svelte`
- Modify: `src/components/workspace/WorkspaceLineActions.svelte`
- Modify: `src/components/workspace/WorkspaceUpload.svelte`

- [ ] **Step 1: Apply the Task 3 surface, text, action, and state mapping**

Preserve existing file-type semantics but normalize their values:

```text
folder, Python, action file -> var(--accent-blue-bright)
Markdown, script special    -> var(--accent-purple)
JSON, YAML, warning file    -> var(--accent-yellow)
shell, success file         -> var(--accent-green)
image, severe file          -> var(--accent-orange)
plain/default file          -> var(--text-muted)
```

Expected: resource panels share the same background and interaction hierarchy; file icons remain distinguishable.

- [ ] **Step 2: Eliminate component-private GitHub-like literals**

Replace literals such as `#a371f7`, `#d29922`, `#2f81f7`, and their equivalent `rgba()` fills with the approved token of the same semantic role. Preserve every existing alpha percentage.

- [ ] **Step 3: Run resource-focused tests**

Run:

```bash
bun test src/components/scripts/ScriptCreateModal.test.js src/components/scripts/ScriptEditor.test.js src/components/scripts/ScriptPanel.test.js src/components/scripts/ScriptTree.test.js src/components/skills/SkillPanel.test.js
vitest run src/components/workspace/WorkspaceUpload.component.test.ts src/components/images/ImageBuildPanel.component.test.ts
bun run check
```

Expected: all selected tests pass and `svelte-check` reports no errors.

- [ ] **Step 4: Review protected properties and commit**

Run `git diff --check` and inspect `git diff -- src/components`.

Expected: only color-bearing declarations changed.

```bash
git add src/components/env src/components/images src/components/mounts src/components/scripts src/components/skills src/components/workspace
git commit -m "style: unify resource management colors"
```

### Task 5: Normalize settings, modal, and page colors

**Files:**
- Modify: `src/components/settings/CapabilityCatalogPanel.svelte`
- Modify: `src/components/settings/GlobalEnvPanel.svelte`
- Modify: `src/components/settings/TokenManagementPanel.svelte`
- Modify: `src/components/settings/WebhookPanel.svelte`
- Modify: `src/components/settings/WebhookRegisterModal.svelte`
- Modify: `src/components/settings/WebhookSourceTable.svelte`
- Modify: `src/modals/PullImageModal.svelte`
- Modify: `src/modals/RemoveImageModal.svelte`
- Modify: `src/modals/RunAgentModal.svelte`
- Modify: `src/pages/CacheListView.svelte`
- Modify: `src/pages/Dashboard.svelte`
- Modify: `src/pages/EventSandboxDetailPage.svelte`
- Modify: `src/pages/ImageListView.svelte`
- Modify: `src/pages/SystemSettings.svelte`
- Modify: `src/pages/VolumeListView.svelte`
- Modify: `src/pages/session/FileBrowser.svelte`
- Modify: `src/pages/session/SessionTerminal.svelte`

- [ ] **Step 1: Apply the approved semantic mapping to settings, modals, and pages**

Use blue only for actions, selection, focus, and links. Use green/yellow/red only for semantic status. Convert black overlays and shadows only when their hue is inconsistent; preserve their alpha, offsets, blur, and spread exactly.

- [ ] **Step 2: Verify modal and settings tests**

Run:

```bash
bun test src/modals/ImageOperations.test.js src/modals/RunAgentModal.test.js
vitest run src/components/settings/CapabilityCatalogPanel.test.ts src/components/settings/GlobalEnvPanel.test.ts src/components/settings/TokenManagementPanel.test.ts src/components/settings/WebhookPanel.test.ts
bun run check
```

Expected: all selected tests pass and `svelte-check` reports no errors.

- [ ] **Step 3: Review protected properties and commit**

Run `git diff --check`, inspect the complete task diff, and confirm every changed CSS value carries color.

```bash
git add src/components/settings src/modals src/pages
git commit -m "style: unify application page colors"
```

### Task 6: Normalize runtime and execution colors

**Files:**
- Modify: `src/views/runtime/AgentListView.svelte`
- Modify: `src/views/runtime/AgentRunListView.svelte`
- Modify: `src/views/runtime/LatestRunView.svelte`
- Modify: `src/views/runtime/ProjectRuntimeView.svelte`
- Modify: `src/views/runtime/RunExecutionProcess.svelte`
- Modify: `src/views/runtime/RuntimeBreadcrumb.svelte`
- Modify: `src/views/runtime/SandboxDetailView.svelte`
- Modify: `src/views/runtime/SandboxListView.svelte`
- Modify: `src/views/runtime/SchedulerListView.svelte`
- Modify: `src/views/runtime/SchedulerRunDetailView.svelte`
- Modify: `src/views/runtime/TimelineEntry.svelte`

- [ ] **Step 1: Apply the approved surface and semantic status mapping**

Runtime state mapping is exact:

```text
running, succeeded, healthy, connected -> var(--accent-green)
queued, waiting, unknown, warning      -> var(--accent-yellow)
failed, error, destructive             -> var(--accent-red)
stopped, severe                        -> var(--accent-orange)
selected, active filter, focus         -> var(--accent-blue)
completed special state                -> var(--accent-purple)
destroyed, disabled, absent            -> var(--text-muted)
```

- [ ] **Step 2: Verify runtime component tests**

Run:

```bash
vitest run test/views/AgentListView.test.ts src/views/runtime/RunExecutionProcess.component.test.ts src/views/runtime/LatestRunAgentCard.component.test.ts
bun run check
```

Expected: all available selected tests pass and `svelte-check` reports no errors. If a named test file is absent, use `rg --files test src/views/runtime | rg 'RunExecutionProcess|LatestRun|AgentListView'` to select the existing equivalent and record the substitution.

- [ ] **Step 3: Review protected properties and commit**

Run `git diff --check`, inspect `git diff -- src/views/runtime`, and confirm only color-bearing values changed.

```bash
git add src/views/runtime
git commit -m "style: unify runtime status colors"
```

### Task 7: Perform the repository-wide color-only audit

**Files:**
- Compare: `/tmp/agent-compose-ui-repository-blue-baseline/src`
- Compare: `src`

- [ ] **Step 1: Inventory remaining literal colors**

Run:

```bash
rg -n --glob '*.css' --glob '*.svelte' '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(' src > /tmp/repository-blue-colors-after.txt
diff -u /tmp/repository-blue-colors-before.txt /tmp/repository-blue-colors-after.txt || true
```

Expected: remaining literals are limited to the approved `:root` palette, black/white overlay colors, and documented syntax/file-type cases. No component-private blue, green, yellow, red, purple, orange, or gray duplicates remain.

- [ ] **Step 2: Audit every changed CSS declaration against the baseline**

Run:

```bash
diff -ru --exclude='*.test.*' /tmp/agent-compose-ui-repository-blue-baseline/src src > /tmp/repository-blue-source.diff || true
rg '^[-+][^-+]' /tmp/repository-blue-source.diff
```

Expected: changed lines contain only color custom properties or these CSS properties: `color`, `background`, `background-color`, `border-color`, `outline-color`/`outline` color component, `box-shadow` color component, `text-shadow` color component, `caret-color`, `accent-color`, `fill`, or `stroke`. Svelte markup, scripts, and protected properties are unchanged.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
bun run check
bun run test
vitest run
bun run build
```

Expected: all commands exit 0; Vite emits a successful production build.

- [ ] **Step 4: Review final repository state**

Run:

```bash
git status --short
git log -5 --oneline
```

Expected: pre-existing user changes remain intact; implementation commits are limited to the documented color files; no `.superpowers/` brainstorming artifacts are staged.

