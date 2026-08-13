<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import type { WorkspaceBinding } from '../../lib/workspace-binding';
  import { createWorkspaceForAgent } from '../../lib/workspace-create';
  import WorkspaceUpload from './WorkspaceUpload.svelte';

  interface Props {
    sourcePath: string;
    binding: WorkspaceBinding | null;
    agentName: string;
    hasPendingChanges?: boolean;
    applying?: boolean;
    onReload?: () => void | Promise<void>;
    disabled?: boolean;
  }

  let {
    sourcePath,
    binding,
    agentName,
    hasPendingChanges = false,
    applying = false,
    onReload = () => {},
    disabled = false,
  }: Props = $props();

  const status = $derived.by(() => {
    if (!binding) return { kind: 'none' as const };
    if (binding.provider && binding.provider !== 'file') {
      return { kind: 'non-file' as const, provider: binding.provider };
    }
    if (!binding.path) return { kind: 'none' as const };
    return { kind: 'valid' as const, path: binding.path };
  });

  let creating = $state(false);

  async function createWorkspace() {
    if (creating) return;
    creating = true;
    try {
      const result = await createWorkspaceForAgent(store.editorContent, agentName, sourcePath);
      store.commitEditorContent(result.yaml);
      if (sourcePath) {
        store.addToast(`已绑定 workspace（path=${result.workspacePath}）`, 'success');
      } else {
        store.addToast(`已配置 workspace path，保存项目后即可上传文件`, 'success');
      }
    } catch (error) {
      store.addToast(
        '绑定 workspace 失败：' + (error instanceof Error ? error.message : String(error)),
        'error',
      );
    } finally {
      creating = false;
    }
  }

  const reloadTitle = $derived(
    hasPendingChanges
      ? 'YAML 中的 workspace 配置已变更，点击重新加载'
      : 'YAML 配置已同步',
  );
</script>

{#if status.kind === 'valid'}
  <div class="binding-bar valid">
    <span class="label">本地 workspace</span>
    <span class="path">{status.path}</span>
    <span class="sep">·</span>
    <span class="sync">● 已绑定</span>
    <div class="actions">
      <WorkspaceUpload {disabled} />
      <button
        type="button"
        class="reload-btn"
        class:pending={hasPendingChanges}
        onclick={() => void onReload()}
        disabled={!hasPendingChanges || applying}
        title={reloadTitle}
      >{applying ? '加载中…' : '重新加载'}</button>
    </div>
  </div>
{:else if status.kind === 'non-file'}
  <div class="binding-bar warn">
    <span class="label">workspace 类型</span>
    <span class="path">{status.provider}</span>
    <span class="sep">·</span>
    <span class="warn-text">非 local 类型，不支持文件管理</span>
    <div class="actions">
      <button
        type="button"
        class="reload-btn"
        class:pending={hasPendingChanges}
        onclick={() => void onReload()}
        disabled={!hasPendingChanges || applying}
        title={reloadTitle}
      >{applying ? '加载中…' : '重新加载'}</button>
    </div>
  </div>
{:else}
  <div class="binding-bar empty">
    <span class="label">未绑定本地 workspace</span>
    <button
      type="button"
      class="create-btn"
      onclick={createWorkspace}
      disabled={creating || disabled}
    >{creating ? '创建中…' : '＋ 绑定 workspace'}</button>
    <span class="hint">设置 <code>workspace.path</code> 为项目相对路径</span>
    <div class="actions">
      <button
        type="button"
        class="reload-btn"
        class:pending={hasPendingChanges}
        onclick={() => void onReload()}
        disabled={!hasPendingChanges || applying}
        title={reloadTitle}
      >{applying ? '加载中…' : '重新加载'}</button>
    </div>
  </div>
{/if}

<style>
  .binding-bar {
    padding: 8px 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--font-size-xs);
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-color);
  }
  .binding-bar.valid {
    background: color-mix(in srgb, var(--accent-blue) 7%, var(--bg-secondary));
  }
  .binding-bar.warn {
    background: color-mix(in srgb, var(--accent-yellow) 7%, var(--bg-secondary));
  }
  .binding-bar.empty {
    background: var(--bg-secondary);
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .path { font-family: var(--font-mono); color: var(--accent-blue); }
  .binding-bar.warn .path { color: var(--accent-yellow); }
  .sep { color: var(--text-muted); }
  .sync { color: var(--accent-green); }
  .warn-text { color: var(--accent-yellow); }
  .hint { color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
  .hint code { color: var(--accent-blue); }
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .create-btn {
    padding: 2px 8px;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 10px;
    font-family: var(--font-sans);
    cursor: pointer;
  }
  .create-btn {
    color: var(--accent-blue);
    border-color: color-mix(in srgb, var(--accent-blue) 50%, var(--border-color));
    background: color-mix(in srgb, var(--accent-blue) 8%, var(--bg-secondary));
  }
  .create-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-blue) 15%, var(--bg-secondary));
    border-color: var(--accent-blue);
  }
  .create-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .reload-btn {
    padding: 2px 8px;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 10px;
    font-family: var(--font-sans);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .reload-btn.pending {
    color: var(--accent-yellow);
    border-color: color-mix(in srgb, var(--accent-yellow) 50%, var(--border-color));
    background: color-mix(in srgb, var(--accent-yellow) 8%, var(--bg-secondary));
  }
  .reload-btn.pending:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-yellow) 15%, var(--bg-secondary));
    border-color: var(--accent-yellow);
  }
  .reload-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
