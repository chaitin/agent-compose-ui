<script lang="ts">
  let { compact = false, class: className = '' }: { compact?: boolean; class?: string } = $props();
</script>

{#if compact}
  <svg class={className} viewBox="0 0 138 78" role="img" aria-label="Agent-Compose">
    <image href="/agent-compose-logo.svg" width="470" height="78" />
  </svg>
{:else}
  <img src="/agent-compose-logo.svg" alt="Agent-Compose" class={className} />
{/if}
