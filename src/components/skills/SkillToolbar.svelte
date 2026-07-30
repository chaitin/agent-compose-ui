<script lang="ts">
  interface Props {
    busy: boolean;
    onCreate: () => void;
    onUpload: () => void;
    onRefresh: () => void;
  }

  let { busy, onCreate, onUpload, onRefresh }: Props = $props();
</script>

<div class="toolbar" role="toolbar" aria-label="Skill 操作">
  <button class="primary" type="button" onclick={onCreate} disabled={busy}>新建 Skill</button>
  <button class="secondary" type="button" onclick={onUpload} disabled={busy}>上传 Skill</button>
  <span class="spacer"></span>
  <button class="ghost" type="button" onclick={onRefresh} disabled={busy}>刷新</button>
</div>

<style>
  .toolbar {
    display: flex;
    min-height: 38px;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  .spacer { flex: 1; }
  button {
    height: 27px;
    padding: 3px 10px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font: inherit;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent-blue); color: var(--accent-blue); }
  button:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 1px; }
  button:disabled { cursor: not-allowed; opacity: .5; }
  .primary {
    border-color: color-mix(in srgb, var(--accent-blue) 55%, var(--border-color));
    color: var(--accent-blue);
    background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-secondary));
    font-weight: 600;
  }
  .primary:hover:not(:disabled) { border-color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 16%, var(--bg-secondary)); }
  .secondary { background: var(--bg-tertiary); }
  .ghost { padding-inline: 8px; border-color: transparent; color: var(--text-secondary); background: transparent; }
  .ghost:hover:not(:disabled) { border-color: var(--border-color); color: var(--text-primary); background: var(--bg-tertiary); }
</style>
