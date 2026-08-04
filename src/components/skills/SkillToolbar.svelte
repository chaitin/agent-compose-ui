<script lang="ts">
  interface Props {
    busy: boolean;
    onCreate: () => void;
    onUpload: () => void;
    onSync: () => void;
    syncDisabled?: boolean;
  }

  let { busy, onCreate, onUpload, onSync, syncDisabled = false }: Props = $props();
</script>

<div class="toolbar" role="toolbar" aria-label="Skill 操作">
  <span class="spacer"></span>
  <button class="upload-btn" type="button" onclick={onSync} disabled={busy || syncDisabled}>
    <span class="btn-icon" aria-hidden="true">↔</span>
    <span class="btn-label">同步配置</span>
  </button>
  <button class="upload-btn" type="button" onclick={onCreate} disabled={busy}>
    <span class="btn-icon" aria-hidden="true">+</span>
    <span class="btn-label">新建 Skill</span>
  </button>
  <button class="upload-btn" type="button" onclick={onUpload} disabled={busy}>
    <span class="btn-icon" aria-hidden="true">📄</span>
    <span class="btn-label">上传 Skill</span>
  </button>
</div>

<style>
  .toolbar {
    display: flex;
    min-height: 30px;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  .spacer { flex: 1; }
  .upload-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
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
  .upload-btn:hover:not(:disabled) {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  }
  .upload-btn:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 1px; }
  .upload-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-icon { font-size: 10px; line-height: 1; }
  .btn-label { line-height: 1.2; white-space: nowrap; }
</style>
