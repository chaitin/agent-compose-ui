<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    children,
    class: className = '',
  }: {
    children: Snippet;
    class?: string;
  } = $props();
</script>

<div class={`mx-auto w-full min-w-0 max-w-[112rem] px-4 py-4 sm:px-5 sm:py-5 xl:px-6 xl:py-6 ${className}`}>
  {@render children()}
</div>
