# Project Image Build Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project image build-file management and changed-image activation builds while preserving every existing resource-panel capability.

**Architecture:** A pure `project-image-files` module maps YAML build specs and checks storage readiness. A new image resource panel reuses the workspace file store, tree, and uploader. The existing Toolbar build executor remains responsible for streamed builds, with a readiness gate and changed-only selection added before activation.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Testing Library, Bun tests, Connect-generated image API clients

---

## File Structure

- Create `src/lib/project-image-files.ts`: map YAML build specs to managed storage locations and check Dockerfile readiness.
- Create `src/lib/project-image-files.test.ts`: deterministic mapping and readiness coverage.
- Create `src/components/images/ImageBuildPanel.svelte`: image source selector, storage binding, upload, tree, and readiness display.
- Create `src/components/images/ImageBuildPanel.component.test.ts`: image panel rendering and safe-path behavior.
- Modify `src/components/workspace/WorkspaceUpload.svelte`: accept an optional file store and upload-path options while preserving defaults.
- Modify `src/components/workspace/WorkspaceUpload.component.test.ts`: cover default and stripped-root upload behavior, creating the file if no focused test exists.
- Modify `src/lib/scripts/workspace.svelte.ts`: add the `images` resource tab and `openImagesTab()`.
- Modify `src/lib/scripts/workspace.test.js`: cover the new tab-opening method.
- Modify `src/components/ResourcePanel.svelte`: add the image tab without changing Scripts, Workspace, Skills, mounts, bindings, or keyboard navigation.
- Modify `src/components/ResourcePanel.component.test.ts`: assert all five tabs and retained navigation.
- Modify `src/components/Toolbar.svelte`: resolve plans from the canonical source path, select changed builds, check files, and route incomplete builds to the image tab.
- Modify `src/components/ToolbarImageBuild.test.js` and `src/components/ToolbarLatestRun.component.test.ts`: cover changed-only automatic build behavior and readiness failures.

### Task 1: Build-source mapping and readiness checks

**Files:**
- Create: `src/lib/project-image-files.ts`
- Create: `src/lib/project-image-files.test.ts`

- [ ] **Step 1: Write failing mapping tests**

Add tests that parse representative YAML and assert that `./workspace/writer` becomes `workspace/writer`, nested `docker/Dockerfile` is retained, absolute contexts are marked server-managed, root contexts are rejected for browser upload, and `..` escapes are rejected.

```ts
expect(buildFileSources(project)[0]).toMatchObject({
  agentName: 'writer',
  imageRef: 'writer:v2',
  storagePath: 'workspace/writer',
  dockerfile: 'docker/Dockerfile',
  manageable: true,
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `bunx vitest run src/lib/project-image-files.test.ts`

Expected: FAIL because `project-image-files.ts` does not exist.

- [ ] **Step 3: Implement deterministic mapping**

Implement `ProjectImageFileSource` and `buildFileSources(spec)`. Normalize slashes and one leading `./`; reject browser management for absolute paths, project root, context escapes, and Dockerfiles outside the context. Do not reject absolute daemon paths from server builds.

- [ ] **Step 4: Add readiness tests**

Inject `resolve` and `listFiles` functions. Assert a matching Dockerfile is ready, a missing Dockerfile reports `缺少 <path>`, a missing directory reports `缺少构建目录 <context>`, and absolute contexts return ready without calling the browser file API.

- [ ] **Step 5: Implement readiness checks and run tests**

Run: `bunx vitest run src/lib/project-image-files.test.ts`

Expected: PASS.

### Task 2: Reusable workspace upload behavior

**Files:**
- Modify: `src/components/workspace/WorkspaceUpload.svelte`
- Test: `src/components/workspace/WorkspaceUpload.component.test.ts`

- [ ] **Step 1: Write failing component/unit tests**

Cover two contracts: omitting props still uploads through `workspaceFiles` with the current path behavior; passing `files`, `locationLabel`, and `stripFolderRoot={true}` routes writes through the supplied store and converts `selected-project/docker/Dockerfile` to `docker/Dockerfile`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `bunx vitest run src/components/workspace/WorkspaceUpload.component.test.ts`

Expected: FAIL because the component does not accept the new props.

- [ ] **Step 3: Add backward-compatible props**

Add:

```ts
interface Props {
  files?: WorkspaceFileStore;
  locationLabel?: string;
  stripFolderRoot?: boolean;
}
let { files = workspaceFiles, locationLabel = 'workspace', stripFolderRoot = false }: Props = $props();
```

Replace upload and existence checks with the selected `files` store. Strip only the first folder segment when requested. Use `locationLabel` only in user-facing overwrite text.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run src/components/workspace/WorkspaceUpload.component.test.ts`

Expected: PASS, including existing default behavior.

### Task 3: Image resource panel and existing-tab preservation

**Files:**
- Create: `src/components/images/ImageBuildPanel.svelte`
- Create: `src/components/images/ImageBuildPanel.component.test.ts`
- Modify: `src/lib/scripts/workspace.svelte.ts`
- Modify: `src/lib/scripts/workspace.test.js`
- Modify: `src/components/ResourcePanel.svelte`
- Modify: `src/components/ResourcePanel.component.test.ts`

- [ ] **Step 1: Update tests first**

Assert `ResourceTab` contains `images`, `openImagesTab()` opens the panel, and the resource panel renders five tabs in this order: Scripts, Workspace, Images, Skills, Data/Mounts. Assert arrow-key navigation still reaches each tab and existing Skills/mount panels still receive their current props.

- [ ] **Step 2: Add image-panel tests**

Assert invalid/empty YAML shows `暂无镜像构建配置`; a build-enabled agent displays its image, context, and Dockerfile; safe relative contexts bind a dedicated `WorkspaceFileStore`; invalid paths display their mapping error without initiating upload.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `bunx vitest run src/components/ResourcePanel.component.test.ts src/components/images/ImageBuildPanel.component.test.ts && bun test src/lib/scripts/workspace.test.js`

Expected: FAIL until the image tab and component exist.

- [ ] **Step 4: Implement the image panel**

Port the source panel selectively. Parse `store.editorContent`, derive sources with `buildFileSources`, maintain an independent `WorkspaceFileStore`, resolve active project/draft bindings, and render the existing workspace uploader/tree. Pass `stripFolderRoot={true}` and keep binding failures local to the selected image.

- [ ] **Step 5: Integrate the tab without replacing current code**

Extend the existing `ResourceTab` union and `resourceTabs` array. Add the image button with the same IDs, ARIA attributes, roving tabindex, and keyboard handler as other tabs. Add an `images` branch while retaining the current Skills and mounts branches and their storage-binding lifecycle.

- [ ] **Step 6: Run focused tests**

Run: `bunx vitest run src/components/ResourcePanel.component.test.ts src/components/images/ImageBuildPanel.component.test.ts && bun test src/lib/scripts/workspace.test.js`

Expected: PASS.

### Task 4: Activation-time readiness and changed-only builds

**Files:**
- Modify: `src/components/Toolbar.svelte`
- Modify: `src/components/ToolbarImageBuild.test.js`
- Modify: `src/components/ToolbarLatestRun.component.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Mock `checkProjectImageFiles` and `scriptWorkspace.openImagesTab`. Assert a first-time draft passes `canonicalSourcePath` to `createProjectImageBuildPlans`; only names returned by `changedBuildAgentNames` are selected; no build section appears for unchanged definitions; incomplete selected files cancel preview, open Images, and emit an error toast.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `bunx vitest run src/components/ToolbarLatestRun.component.test.ts && bun test src/components/ToolbarImageBuild.test.js`

Expected: FAIL on changed-only selection and readiness behavior.

- [ ] **Step 3: Implement readiness orchestration**

Import `checkProjectImageFiles`. Build from `canonicalSourcePath`, select only valid changed plans, await readiness checks for selected names, guard the async result with the existing preview generation, and on failure clear pending build state, close the preview, open Images, and toast the precise missing item.

- [ ] **Step 4: Preserve the existing activation choice where compatible**

Keep current activation/apply/run controls and streamed build executor. Automatically hide the build section when no changed builds are selected. For changed builds, show the existing no-cache, pull, phase rail, result lines, warnings, and failure retry behavior. Do not modify image list/pull/remove flows.

- [ ] **Step 5: Run focused tests**

Run: `bunx vitest run src/components/ToolbarLatestRun.component.test.ts && bun test src/components/ToolbarImageBuild.test.js src/modals/ImageOperations.test.js`

Expected: PASS.

### Task 5: Integrated regression and quality gates

**Files:**
- Verify all files above; no generated files should change.

- [ ] **Step 1: Review the diff for accidental source-repository copying**

Run: `git diff --stat && git diff --check`

Expected: only image-build management, reusable upload integration, tests, and approved docs; no run-stats, sidebar, settings, server, protobuf, or generated-client changes.

- [ ] **Step 2: Run all component and Bun tests**

Run: `bun run test && bun run test:component`

Expected: PASS.

- [ ] **Step 3: Run static checks and production build**

Run: `bun run check && bun run build`

Expected: PASS.

- [ ] **Step 4: Report preserved user changes**

Confirm the pre-existing untracked Docker all-in-one files and unrelated test fixtures remain untouched and uncommitted unless they overlap a required test file.
