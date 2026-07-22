<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import WorkspaceBindingBar from './WorkspaceBindingBar.svelte';
  import WorkspaceFileTree from './WorkspaceFileTree.svelte';
  import WorkspaceFilePreview from './WorkspaceFilePreview.svelte';
  import { parseWorkspaceBinding, isWorkspaceBindingValid, defaultWorkspacePath } from '../../lib/workspace-binding';
  import { workspaceFiles } from '../../lib/workspace/store.svelte';

  const binding = $derived(parseWorkspaceBinding(store.editorContent));
  const isValid = $derived(isWorkspaceBindingValid(binding));
  const workspacePath = $derived(binding?.path ?? defaultWorkspacePath());

  const currentProject = $derived(store.projects.find(p => p.summary.projectId === store.activeProjectId));
  const sourcePath = $derived(currentProject?.summary.sourcePath ?? '');

  $effect(() => {
    if (!isValid) {
      workspaceFiles.setWorkspace('', '');
      return;
    }
    workspaceFiles.setWorkspace(sourcePath, workspacePath);
  });

  const loadError = $derived(workspaceFiles.lastError);

  let recreating = $state(false);

  async function retryLoad() {
    const result = await workspaceFiles.refresh();
    if (result.error) {
      store.addToast('加载文件列表失败：' + result.error.message, 'error');
    }
  }

  function handleSelect(path: string) {
    workspaceFiles.activePath = path;
  }
</script>

<div class="workspace-panel">
  <WorkspaceBindingBar {sourcePath} />
  {#if isValid}
    <div class="workspace-body">
      {#if loadError && workspaceFiles.files.length === 0}
        <div class="load-error">
          <div class="error-icon">⚠</div>
          <div class="error-title">加载文件列表失败</div>
          <div class="error-desc">{loadError.message}</div>
          <button type="button" class="retry-btn" onclick={retryLoad}>重试</button>
        </div>
      {:else}
        <div class="workspace-left">
          <WorkspaceFileTree
            files={workspaceFiles.files}
            activePath={workspaceFiles.activePath}
            onSelect={handleSelect}
          />
        </div>
        <WorkspaceFilePreview />
      {/if}
    </div>
  {:else}
    <div class="workspace-body disabled">
      <div class="placeholder">
        <div class="placeholder-icon">⌥</div>
        <div class="placeholder-title">文件管理不可用</div>
        <div class="placeholder-desc">
          {#if binding?.provider && binding.provider !== 'local'}
            当前 workspace 类型为 <code>{binding.provider}</code>，文件管理仅支持 <code>local</code> 类型
          {:else}
            请先在 YAML 中配置 <code>agents.&lt;name&gt;.workspace.path</code>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .workspace-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .workspace-body {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    background: var(--bg-primary);
    overflow: hidden;
  }
  .workspace-left {
    display: flex;
    flex-direction: column;
    width: 260px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-color);
    min-height: 0;
  }
  .workspace-body.disabled,
  .load-error {
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
  }
  .load-error {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--text-muted);
    text-align: center;
    padding: 24px;
  }
  .error-icon { font-size: 32px; opacity: 0.5; }
  .error-title { font-size: var(--font-size-md); color: var(--text-secondary); font-weight: 600; }
  .error-desc { font-size: var(--font-size-xs); max-width: 360px; line-height: 1.5; }
  .error-desc code { color: var(--accent-blue); font-family: var(--font-mono); }
  .retry-btn {
    margin-top: 8px;
    padding: 6px 14px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .retry-btn:hover {
    color: var(--accent-blue);
    border-color: var(--accent-blue);
  }
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    text-align: center;
    padding: 24px;
  }
  .placeholder-icon { font-size: 32px; opacity: 0.3; }
  .placeholder-title { font-size: var(--font-size-md); color: var(--text-secondary); font-weight: 600; }
  .placeholder-desc { font-size: var(--font-size-xs); max-width: 360px; }
  .placeholder-desc code { color: var(--accent-blue); font-family: var(--font-mono); }
</style>
