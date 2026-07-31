<script lang="ts">
  interface Props {
    mode: 'file' | 'folder';
    defaultDir?: string;
    directories: string[];
    onCreate: (path: string) => void;
    onCancel: () => void;
  }
  let { mode, defaultDir = '', directories, onCreate, onCancel }: Props = $props();

  let name = $state('');
  let selectedDir = $state('');

  $effect(() => {
    if (!selectedDir && defaultDir) selectedDir = defaultDir;
  });

  const error = $derived.by(() => {
    const trimmed = name.trim();
    if (!trimmed) return '';
    if (/[\\/\0]/.test(trimmed)) return mode === 'file' ? '文件名不能包含路径分隔符' : '目录名不能包含路径分隔符';
    if (mode === 'file' && !trimmed.endsWith('.js')) return '文件名必须以 .js 结尾';
    if (mode === 'folder' && trimmed.includes('.')) return '目录名不能包含点';
    return '';
  });

  const fullPath = $derived(selectedDir ? `${selectedDir}/${name.trim()}` : name.trim());
  const canSubmit = $derived(name.trim().length > 0 && !error);

  function submit() {
    if (!canSubmit) return;
    onCreate(fullPath);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') submit();
    if (event.key === 'Escape') onCancel();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={onCancel} role="presentation">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-card" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()} onkeydown={onKeydown} tabindex="-1">
    <div class="modal-title">{mode === 'file' ? '新建脚本文件' : '新建文件夹'}</div>

    <label class="field">
      <span class="field-label">{mode === 'file' ? '文件名' : '目录名'}</span>
      <input
        type="text"
        bind:value={name}
        placeholder={mode === 'file' ? '例如 daily-report.js' : '例如 scripts'}
        onkeydown={onKeydown}
      />
    </label>

    <label class="field">
      <span class="field-label">所属目录</span>
      <select bind:value={selectedDir}>
        <option value="">（根目录）</option>
        {#each directories as dir (dir)}
          <option value={dir}>{dir}/</option>
        {/each}
      </select>
    </label>

    <div class="preview">完整路径：<code>{fullPath || '—'}</code></div>
    {#if error}
      <div class="field-error">{error}</div>
    {/if}

    <div class="modal-actions">
      <button class="btn-secondary" onclick={onCancel}>取消</button>
      <button class="btn-primary" disabled={!canSubmit} onclick={submit}>创建</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .modal-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    width: 360px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .modal-title {
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--text-primary);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  input, select {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 6px 8px;
    border-radius: 4px;
    font-size: var(--font-size-md);
    font-family: var(--font-mono);
  }
  input:focus, select:focus {
    outline: none;
    border-color: var(--accent-blue);
  }
  .preview {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
  .preview code {
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }
  .field-error {
    font-size: var(--font-size-sm);
    color: var(--accent-red);
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .btn-primary, .btn-secondary {
    padding: 6px 14px;
    border-radius: 4px;
    font-size: var(--font-size-md);
    cursor: pointer;
    border: 1px solid var(--border-color);
  }
  .btn-primary {
    background: var(--accent-blue);
    color: #0d1117;
    border-color: var(--accent-blue);
    font-weight: 600;
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
</style>
