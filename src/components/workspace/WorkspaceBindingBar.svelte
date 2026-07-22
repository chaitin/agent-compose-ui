<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import { parseWorkspaceBinding } from '../../lib/workspace-binding';
  import { createWorkspaceAndBind } from '../../lib/workspace-create';
  import WorkspaceUpload from './WorkspaceUpload.svelte';

  interface Props {
    sourcePath: string;
  }

  let { sourcePath }: Props = $props();

  const binding = $derived(parseWorkspaceBinding(store.editorContent));

  const status = $derived.by(() => {
    if (!binding) return { kind: 'none' as const };
    if (binding.provider && binding.provider !== 'local') {
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
      const result = await createWorkspaceAndBind(store.editorContent, sourcePath);
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
</script>

{#if status.kind === 'valid'}
  <div class="binding-bar valid">
    <span class="label">本地 workspace</span>
    <span class="path">{status.path}</span>
    <span class="sep">·</span>
    <span class="sync">● 已绑定</span>
    <WorkspaceUpload />
  </div>
{:else if status.kind === 'non-file'}
  <div class="binding-bar warn">
    <span class="label">workspace 类型</span>
    <span class="path">{status.provider}</span>
    <span class="sep">·</span>
    <span class="warn-text">非 local 类型，不支持文件管理</span>
  </div>
{:else}
  <div class="binding-bar empty">
    <span class="label">未绑定本地 workspace</span>
    <button
      type="button"
      class="create-btn"
      onclick={createWorkspace}
      disabled={creating}
    >{creating ? '创建中…' : '＋ 绑定 workspace'}</button>
    <span class="hint">设置 <code>workspace.path</code> 为项目相对路径</span>
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
  :global(.binding-bar.valid > .upload-bar) { margin-left: auto; }
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
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
