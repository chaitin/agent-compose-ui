<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import type { ScriptWorkspace } from '../../lib/scripts/workspace.svelte';
  import { collectScriptDirectories, countScriptFiles } from '../../lib/scripts/tree';
  import { scriptErrorMessage } from '../../lib/scripts/api';
  import ScriptTree from './ScriptTree.svelte';
  import ScriptEditor from './ScriptEditor.svelte';
  import ScriptCreateModal from './ScriptCreateModal.svelte';

  interface Props {
    workspace: ScriptWorkspace;
  }
  let { workspace }: Props = $props();

  let createMode = $state<'file' | null>(null);
  let treeWidth = $state(220);
  let resizing = false;

  const dirtyPaths = $derived(
    new Set([...workspace.files.values()].filter((f) => f.dirty).map((f) => f.path)),
  );
  const fileCount = $derived(countScriptFiles(workspace.tree));
  const directories = $derived(collectScriptDirectories(workspace.tree));

  function message(e: unknown): string {
    return scriptErrorMessage(e);
  }

  async function ensureTree() {
    try {
      await workspace.refreshTree();
    } catch (e) {
      store.addToast('脚本服务不可用：' + message(e), 'error');
    }
  }

  $effect(() => {
    workspace.contextRevision;
    if (workspace.panelOpen) void ensureTree();
  });

  async function handleOpen(path: string) {
    try {
      await workspace.openFile(path);
    } catch (e) {
      store.addToast('打开失败：' + message(e), 'error');
    }
  }

  async function handleCreateFile(path: string) {
    try {
      await workspace.createFile(path);
      createMode = null;
      store.addToast(`已创建 ${path}`, 'success');
    } catch (e) {
      store.addToast('创建失败：' + message(e), 'error');
    }
  }

  async function handleDeleteFile(path: string) {
    try {
      await workspace.deleteFile(path);
      store.addToast(`已删除 ${path}`, 'success');
    } catch (e) {
      store.addToast('删除失败：' + message(e), 'error');
    }
  }

  async function handleDeleteFolder(path: string) {
    try {
      await workspace.deleteFolder(path);
      store.addToast(`已删除 ${path}`, 'success');
    } catch (e) {
      store.addToast('删除失败：' + message(e), 'error');
    }
  }

  function startResize(event: MouseEvent) {
    event.preventDefault();
    resizing = true;
    const startX = event.clientX;
    const startWidth = treeWidth;
    const onMove = (e: MouseEvent) => {
      if (!resizing) return;
      treeWidth = Math.max(140, Math.min(480, startWidth + (e.clientX - startX)));
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
</script>

<div class="script-tab-content">
  <div class="tree-pane" style="width:{treeWidth}px">
    <ScriptTree
      tree={workspace.tree}
      activePath={workspace.activePath}
      {dirtyPaths}
      onOpen={handleOpen}
      onDeleteFile={handleDeleteFile}
      onDeleteFolder={handleDeleteFolder}
    />
  </div>
  <button class="resizer" aria-label="调整脚本目录宽度" onmousedown={startResize}></button>
  <ScriptEditor {workspace} onCreateFile={() => (createMode = 'file')} />
</div>

{#if createMode}
  <ScriptCreateModal
    mode={createMode}
    defaultDir={workspace.projectName}
    {directories}
    onCreate={handleCreateFile}
    onCancel={() => (createMode = null)}
  />
{/if}

<style>
  .script-tab-content {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .tree-pane {
    flex-shrink: 0;
    min-width: 0;
    overflow: hidden;
    display: flex;
  }
  .resizer {
    width: 4px;
    padding: 0;
    border: 0;
    cursor: col-resize;
    background: var(--border-color);
    flex-shrink: 0;
  }
  .resizer:hover { background: var(--accent-blue); }
</style>
