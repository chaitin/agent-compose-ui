<script lang="ts">
  import { store } from '../lib/stores.svelte';
</script>

<div class="toast-container">
  {#each store.toasts as t (t.id)}
    <div class="toast {t.level}">
      <span class="level-icon">
        {#if t.level === 'error'}✕
        {:else if t.level === 'success'}✓
        {:else}ℹ
        {/if}
      </span>
      <pre class="message">{t.message}</pre>
    </div>
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    bottom: 16px;
    right: 16px;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    z-index: 9999;
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 14px;
    border-radius: 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    max-width: 420px;
    pointer-events: auto;
    animation: slideIn 0.2s ease-out;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  .toast.error { border-left: 3px solid var(--accent-red); }
  .toast.success { border-left: 3px solid var(--accent-green); }
  .toast.info { border-left: 3px solid var(--accent-blue); }
  .level-icon { font-size: 14px; margin-top: 1px; flex-shrink: 0; }
  .toast.error .level-icon { color: var(--accent-red); }
  .toast.success .level-icon { color: var(--accent-green); }
  .toast.info .level-icon { color: var(--accent-blue); }
  .message {
    font-size: var(--font-size-md);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    color: var(--text-primary);
  }
  @keyframes slideIn {
    from { transform: translateY(10px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
