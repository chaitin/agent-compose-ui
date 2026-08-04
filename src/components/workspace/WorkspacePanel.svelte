<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import WorkspaceBindingBar from './WorkspaceBindingBar.svelte';
  import WorkspaceFileTree from './WorkspaceFileTree.svelte';
  import WorkspaceFilePreview from './WorkspaceFilePreview.svelte';
  import { listWorkspaceBindings, parseWorkspaceBinding, isWorkspaceBindingValid, defaultWorkspacePath } from '../../lib/workspace-binding';
  import { workspaceFiles } from '../../lib/workspace/store.svelte';
  import { workspaceBindings, setProjectBindingOverride, projectStorageErrorMessage, legacyKeyFromSourcePath } from '../../lib/workspace/bindings';

  const bindings = $derived(listWorkspaceBindings(store.editorContent));
  const agentNames = $derived(bindings.map((b) => b.agentName));
  let selectedAgent = $state('');

  $effect(() => {
    if (agentNames.length === 0) {
      if (selectedAgent !== '') selectedAgent = '';
      return;
    }
    if (!agentNames.includes(selectedAgent)) selectedAgent = agentNames[0];
  });

  const binding = $derived(parseWorkspaceBinding(store.editorContent, selectedAgent) ?? null);
  const isValid = $derived(isWorkspaceBindingValid(binding));
  const workspacePath = $derived(binding?.path ?? defaultWorkspacePath());

  const currentProject = $derived(store.projects.find(p => p.summary.projectId === store.activeProjectId));
  const sourcePath = $derived(currentProject?.summary.sourcePath ?? store.activeDraftBinding().sourcePath ?? '');

  let bindingError = $state('');
  let bindingGeneration = 0;

  $effect(() => {
    const generation = ++bindingGeneration;
    const path = workspacePath;
    if (!isValid) {
      workspaceFiles.setWorkspace('', '');
      return;
    }
    const projectId = store.activeProjectId;
    const draft = store.activeDraftBinding();
    if (!projectId && !store.activeDraftId) store.ensureEditorDraftSourcePath();
    const draftId = store.activeDraftId;
    const identity = projectId ? `project:${projectId}` : `draft:${draftId}`;
    void (async () => {
      try {
        let resolved;
        try {
          resolved = await workspaceBindings.ensure(identity, {
            projectKey: projectId ? undefined : draft.projectKey,
            sourcePath: projectId ? sourcePath : draft.sourcePath,
            legacyKey: projectId ? legacyKeyFromSourcePath(sourcePath) : store.browserDrafts.find((item) => item.id === store.activeDraftId)?.legacyStorageKey,
            ensureWorkspace: true,
          });
        } catch {
          if (!projectId) throw new Error('项目 Workspace 绑定恢复失败');
          resolved = await workspaceBindings.ensure(`${identity}:replacement`, { ensureWorkspace: true });
          setProjectBindingOverride(projectId, resolved);
        }
        if (generation !== bindingGeneration) return;
        if (!projectId) store.persistActiveDraftBinding(resolved, draftId);
        bindingError = '';
        workspaceFiles.setWorkspace(resolved.projectKey, path);
      } catch (error) {
        if (generation !== bindingGeneration) return;
        bindingError = projectStorageErrorMessage(error);
        workspaceFiles.setWorkspace('', path);
      }
    })();
  });

  const loadError = $derived(bindingError ? { message: bindingError } : workspaceFiles.lastError);

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
  {#if agentNames.length > 1}
    <div class="agent-selector">
      <label class="agent-label" for="workspace-agent-select">智能体</label>
      <select
        id="workspace-agent-select"
        class="agent-select"
        aria-label="选择智能体 workspace"
        value={selectedAgent}
        onchange={(event) => { selectedAgent = (event.currentTarget as HTMLSelectElement).value; }}
      >
        {#each agentNames as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </div>
  {/if}
  <WorkspaceBindingBar {sourcePath} {binding} agentName={selectedAgent} />
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
          {#if binding?.provider && binding.provider !== 'file'}
            当前 workspace 类型为 <code>{binding.provider}</code>，文件管理仅支持 <code>file</code> 类型
          {:else if agentNames.length > 0}
            请先在 YAML 中为智能体 <code>{selectedAgent}</code> 配置 <code>workspace.path</code>
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
  .agent-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-tertiary);
    padding: 4px 10px;
  }
  .agent-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;
  }
  .agent-select {
    flex: 1;
    min-width: 0;
    max-width: 240px;
    padding: 3px 8px;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    font-family: var(--font-sans);
    cursor: pointer;
  }
  .agent-select:hover {
    border-color: var(--accent-blue);
  }
  .agent-select:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: 1px;
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
