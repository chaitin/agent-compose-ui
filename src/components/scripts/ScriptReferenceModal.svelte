<script lang="ts">
  import type { ScriptTreeNode } from '../../lib/scripts/types';
  import { collectScriptFiles } from '../../lib/scripts/tree';

  interface Props {
    mode: 'extract' | 'reference';
    tree: ScriptTreeNode | null;
    defaultPath?: string;
    fileExists?: boolean;
    busy?: boolean;
    onConfirm: (path: string) => void;
    onCancel: () => void;
  }

  let {
    mode,
    tree,
    defaultPath = '',
    fileExists = false,
    busy = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  let path = $state('');
  let initialized = false;

  $effect(() => {
    if (!initialized) {
      path = defaultPath;
      initialized = true;
    }
  });

  const files = $derived(collectScriptFiles(tree));
  const error = $derived.by(() => {
    const value = path.trim();
    if (!value) return '';
    if (value.startsWith('/') || value.includes('..') || /[\\\0]/.test(value)) return '请输入脚本目录内的相对路径';
    if (!value.endsWith('.js')) return '文件路径必须以 .js 结尾';
    return '';
  });
  const canSubmit = $derived(path.trim().endsWith('.js') && !error && !busy);

  function submit() {
    if (!canSubmit) return;
    onConfirm(path.trim());
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') submit();
    if (event.key === 'Escape') onCancel();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={onCancel} role="presentation">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-card" role="dialog" aria-modal="true" onclick={(event) => event.stopPropagation()} onkeydown={onKeydown} tabindex="-1">
    <div class="modal-title">{mode === 'extract' ? (fileExists ? '更新脚本文件' : '提取脚本到文件') : '引用已有脚本'}</div>
    <p class="modal-description">
      {mode === 'extract'
        ? (fileExists ? '内联代码将覆盖写入已有文件。' : '内联代码将写入新文件，YAML 中保留可点击的脚本文件地址。')
        : '选择一个已有脚本文件，替换当前 YAML 中的 script 内容。'}
    </p>

    {#if mode === 'extract'}
      <label class="field">
        <span class="field-label">完整路径</span>
        <input bind:value={path} onkeydown={onKeydown} spellcheck="false" />
      </label>
      {#if error}<div class="field-error">{error}</div>{/if}
    {:else if files.length > 0}
      <div class="file-list" role="radiogroup" aria-label="脚本文件">
        {#each files as file (file.path)}
          <label class="file-option" class:selected={path === file.path}>
            <input type="radio" name="script-reference" value={file.path} bind:group={path} />
            <span class="file-icon">JS</span>
            <span class="file-path">{file.path}</span>
          </label>
        {/each}
      </div>
    {:else}
      <div class="empty-state">暂无可引用的脚本文件</div>
    {/if}

    <div class="modal-actions">
      <button class="btn-secondary" onclick={onCancel} disabled={busy}>取消</button>
      <button class="btn-primary" onclick={submit} disabled={!canSubmit}>
        {busy ? '处理中...' : mode === 'extract' ? (fileExists ? '更新文件' : '提取文件') : '确认引用'}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: absolute;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.58);
  }
  .modal-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(440px, calc(100% - 32px));
    max-height: min(520px, calc(100% - 32px));
    padding: 18px;
    overflow: hidden;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 9px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
  }
  .modal-title { color: var(--text-primary); font-size: var(--font-size-lg); font-weight: 650; }
  .modal-description { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5; }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field-label { color: var(--text-secondary); font-size: var(--font-size-sm); }
  .field input {
    padding: 7px 9px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--font-size-md);
  }
  .field input:focus { outline: none; border-color: #a371f7; }
  .field-error { color: var(--accent-red); font-size: var(--font-size-sm); }
  .file-list {
    min-height: 0;
    max-height: 300px;
    overflow: auto;
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }
  .file-option {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 11px;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .file-option:last-child { border-bottom: 0; }
  .file-option:hover, .file-option.selected { background: rgba(163, 113, 247, 0.09); color: var(--text-primary); }
  .file-icon {
    padding: 2px 4px;
    border-radius: 3px;
    background: rgba(163, 113, 247, 0.14);
    color: #c9a7ff;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 700;
  }
  .file-path { min-width: 0; overflow: hidden; font-family: var(--font-mono); font-size: var(--font-size-sm); text-overflow: ellipsis; white-space: nowrap; }
  .empty-state { padding: 28px 16px; border: 1px dashed var(--border-color); border-radius: 6px; color: var(--text-muted); font-size: var(--font-size-md); text-align: center; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .btn-primary, .btn-secondary { padding: 6px 14px; border: 1px solid var(--border-color); border-radius: 4px; font-size: var(--font-size-md); }
  .btn-primary { background: #a371f7; border-color: #a371f7; color: #0d1117; font-weight: 650; }
  .btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); }
  button:disabled { cursor: not-allowed; opacity: 0.5; }
</style>
