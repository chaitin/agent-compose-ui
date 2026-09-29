<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n.svelte';

  let {
    title,
    description: _description = '',
    compact: _compact = false,
    meta,
    actions,
    children,
  }: {
    title: string;
    /** 保留给读屏：页面说明不再占用可见空间，页面本身应该自解释。 */
    description?: string;
    /** 旧参数，保留兼容；页头现在只有一种紧凑高度。 */
    compact?: boolean;
    meta?: Snippet;
    actions?: Snippet;
    children?: Snippet;
  } = $props();

  // 顶栏面包屑与区段页签已经写出页面名称，标题只留给读屏，避免同一个词在屏幕上出现两次。
  const visible = $derived(Boolean(meta) || Boolean(actions));
</script>

{#if visible}
  <div data-page-header class="sticky top-0 z-20 shrink-0 bg-background">
    <div
      data-page-frame
      class="mx-auto flex w-full max-w-[112rem] flex-col gap-2 px-4 py-2.5 sm:px-5 md:flex-row md:items-center md:justify-between xl:px-6"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <h1 class="sr-only">{t(title)}</h1>
        {#if meta}<div class="flex min-w-0 flex-wrap items-center gap-2">{@render meta()}</div>{/if}
      </div>
      {#if actions}
        <div class="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
          {@render actions()}
        </div>
      {/if}
    </div>
  </div>
{:else}
  <h1 class="sr-only">{t(title)}</h1>
{/if}
{#if children}
  {@render children()}
{/if}
