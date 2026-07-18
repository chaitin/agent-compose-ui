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
  let panelHeight = $state(240);
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

  function startVerticalResize(event: MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panelHeight;
    const maxHeight = Math.max(120, window.innerHeight - 200);
    const onMove = (e: MouseEvent) => {
      // 向上拖（clientY 减小）-> 面板变高
      panelHeight = Math.max(120, Math.min(maxHeight, startHeight + (startY - e.clientY)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
</script>

<section
  class="script-panel"
  class:open={workspace.panelOpen}
  style:height={workspace.panelOpen ? `${panelHeight}px` : undefined}
>
  {#if workspace.panelOpen}
    <button
      class="panel-resizer"
      type="button"
      aria-label="调整脚本面板高度"
      onmousedown={startVerticalResize}
    ></button>
  {/if}
  <button class="panel-header" onclick={() => (workspace.panelOpen = !workspace.panelOpen)}>
    <span class="header-chevron">{workspace.panelOpen ? '⌄' : '›'}</span>
    <span class="header-title">脚本文件</span>
    <span class="header-count">{fileCount}</span>
    {#if !workspace.serviceAvailable}
      <span class="header-status" title="脚本服务不可用">●</span>
    {/if}
  </button>

  {#if workspace.panelOpen}
    <div class="panel-body">
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
        directories={directories}
        onCreate={handleCreateFile}
        onCancel={() => (createMode = null)}
      />
    {/if}
  {/if}
</section>

<style>
  .script-panel {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-shrink: 0;
    position: relative;
  }
  .script-panel:not(.open) {
    height: 32px;
  }
  .script-panel.open {
    min-height: 120px;
    /* height 由 panelHeight 状态通过 inline style 控制 */
  }
  .panel-resizer {
    height: 4px;
    width: 100%;
    padding: 0;
    border: 0;
    background: var(--border-color);
    cursor: row-resize;
    flex-shrink: 0;
    transition: background 0.1s;
  }
  .panel-resizer:hover,
  .panel-resizer:active {
    background: var(--accent-blue);
  }
  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    background: var(--bg-tertiary);
    border: none;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    height: 32px;
    flex-shrink: 0;
  }
  .panel-header:hover { color: var(--text-primary); }
  .header-chevron { font-size: 10px; }
  .header-title { font-weight: 600; }
  .header-count {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 0 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .header-status {
    color: var(--accent-red);
    font-size: var(--font-size-xs);
    margin-left: auto;
  }
  .panel-body {
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
