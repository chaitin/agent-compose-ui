<script lang="ts">
  let { specHash = '', synced = false }: { specHash?: string; synced?: boolean } = $props();
</script>

<span class="status" class:synced>
  {#if synced}
    &#10003; 已同步
  {:else if specHash}
    {specHash.slice(0, 7)}
  {:else}
    未保存
  {/if}
</span>

<style>
  .status {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
  }
  .status.synced {
    color: var(--accent-green);
  }
</style>
