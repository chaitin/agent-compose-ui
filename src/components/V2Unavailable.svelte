<script lang="ts">
  let {
    title,
    reason,
    showContext = true,
  }: { title: string; reason: string; showContext?: boolean } = $props();
</script>

<section class="unavailable" aria-label={title}>
  {#if showContext}
    <p class="eyebrow">当前 v2 API 未提供此能力</p>
  {/if}
  <h2>{title}</h2>
  <p class="reason">{reason}</p>
</section>

<style>
  .unavailable { margin: auto; width: min(560px, calc(100% - 48px)); padding: 28px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); }
  .eyebrow { margin: 0 0 8px; color: var(--accent-orange); font: var(--font-size-sm) var(--font-mono); }
  h2 { margin: 0 0 10px; font-size: var(--font-size-2xl); }
  .reason { margin: 0; color: var(--text-secondary); font-size: var(--font-size-md); line-height: 1.6; }
</style>
