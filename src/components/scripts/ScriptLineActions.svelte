<script lang="ts">
  interface Props {
    kind: 'inline' | 'reference';
    empty?: boolean;
    fileExists?: boolean;
    onMode: () => void;
    onExtract: () => void;
    onReference: () => void;
    onInline: () => void;
  }

  let { kind, empty = false, fileExists = false, onMode, onExtract, onReference, onInline }: Props = $props();
</script>

<div class="script-line-actions">
  {#if kind === 'inline'}
    {#if empty}
      <button class="mode-button" aria-pressed="true" onclick={onMode}>内联脚本</button>
      <button onclick={onReference}>📁 引用已有文件</button>
    {:else}
      <button onclick={onExtract}>▶ {fileExists ? '更新文件' : '提取到文件'}</button>
    {/if}
  {:else}
    <button onclick={onInline}>切换内联</button>
  {/if}
</div>

<style>
  .script-line-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    pointer-events: auto;
  }
  button {
    min-width: 0;
    max-width: 100%;
    padding: 2px 8px;
    border: 1px solid var(--accent-blue);
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent-blue) 7%, transparent);
    color: var(--accent-blue);
    cursor: pointer;
    font-size: var(--font-size-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background 0.15s;
  }
  button:hover { background: color-mix(in srgb, var(--accent-blue) 12%, transparent); }
  .mode-button { font-weight: 600; }
</style>
