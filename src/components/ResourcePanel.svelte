<script lang="ts">
  import type { ScriptWorkspace } from '../lib/scripts/workspace.svelte';
  import { countScriptFiles } from '../lib/scripts/tree';
  import ScriptPanel from './scripts/ScriptPanel.svelte';
  import WorkspacePanel from './workspace/WorkspacePanel.svelte';
  import { workspaceFiles } from '../lib/workspace/store.svelte';

  interface Props {
    workspace: ScriptWorkspace;
  }
  let { workspace }: Props = $props();

  let panelHeight = $state(240);
  let resizing = false;

  const scriptFileCount = $derived(workspace.tree ? countScriptFiles(workspace.tree) : 0);
  const workspaceFileCount = $derived(workspaceFiles.files.filter((f) => !f.dir).length);

  function startVerticalResize(event: MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panelHeight;
    const maxHeight = Math.max(120, window.innerHeight - 200);
    resizing = true;
    const onMove = (e: MouseEvent) => {
      if (!resizing) return;
      panelHeight = Math.max(120, Math.min(maxHeight, startHeight + (startY - e.clientY)));
    };
    const onUp = () => {
      resizing = false;
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

  function selectTab(tab: 'scripts' | 'workspace') {
    workspace.activeTab = tab;
    if (!workspace.panelOpen) workspace.panelOpen = true;
  }
</script>

<section
  class="resource-panel"
  class:open={workspace.panelOpen}
  style:height={workspace.panelOpen ? `${panelHeight}px` : undefined}
>
  {#if workspace.panelOpen}
    <button
      class="panel-resizer"
      type="button"
      aria-label="调整资源面板高度"
      onmousedown={startVerticalResize}
    ></button>
  {/if}
  <div class="resource-tabs">
    <button
      type="button"
      class="resource-toggle"
      aria-label={workspace.panelOpen ? '折叠资源面板' : '展开资源面板'}
      onclick={() => (workspace.panelOpen = !workspace.panelOpen)}
    >
      <span class="chevron">{workspace.panelOpen ? '⌄' : '›'}</span>
      <span class="title">项目资源</span>
    </button>
    <button
      type="button"
      class="resource-tab"
      class:active={workspace.activeTab === 'scripts'}
      role="tab"
      aria-selected={workspace.activeTab === 'scripts'}
      onclick={() => selectTab('scripts')}
    >
      <span>脚本文件</span>
      <span class="count">{scriptFileCount}</span>
    </button>
    <button
      type="button"
      class="resource-tab"
      class:active={workspace.activeTab === 'workspace'}
      role="tab"
      aria-selected={workspace.activeTab === 'workspace'}
      onclick={() => selectTab('workspace')}
    >
      <span>Workspace 文件</span>
      <span class="count">{workspaceFileCount}</span>
    </button>
    {#if !workspace.serviceAvailable && workspace.activeTab === 'scripts'}
      <span class="header-status" title="脚本服务不可用">●</span>
    {/if}
  </div>

  {#if workspace.panelOpen}
    <div class="panel-body">
      {#if workspace.activeTab === 'scripts'}
        <ScriptPanel {workspace} />
      {:else}
        <WorkspacePanel />
      {/if}
    </div>
  {/if}
</section>

<style>
  .resource-panel {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-shrink: 0;
    position: relative;
  }
  .resource-panel:not(.open) {
    height: 32px;
  }
  .resource-panel.open {
    min-height: 120px;
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
  .resource-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
    padding: 0 8px;
    height: 32px;
    flex-shrink: 0;
  }
  .resource-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    font-family: var(--font-sans);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .resource-toggle:hover { color: var(--text-primary); }
  .resource-toggle .chevron { font-size: 10px; }
  .resource-toggle .title { font-weight: 600; }
  .resource-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
  }
  .resource-tab:hover { color: var(--text-primary); }
  .resource-tab.active { color: var(--text-primary); border-bottom-color: var(--accent-blue); }
  .resource-tab .count {
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    padding: 0 6px;
    border-radius: 10px;
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .resource-tab.active .count {
    background: var(--bg-primary);
    color: var(--accent-blue);
    border-color: var(--accent-blue);
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
</style>
