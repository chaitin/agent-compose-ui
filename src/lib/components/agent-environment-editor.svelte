<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t } from '$lib/i18n.svelte';
  import type { AgentEnvironmentVariable } from '../../model/agent-environment';

  let {
    items = $bindable([]),
    title = '智能体环境变量',
    description = '随智能体部署到执行环境',
    layout = 'wide',
    class: className = '',
  }: {
    items?: AgentEnvironmentVariable[];
    title?: string;
    description?: string;
    layout?: 'wide' | 'stacked';
    class?: string;
  } = $props();

  function add(): void {
    items = [...items, { name: '', value: '', secret: false }];
  }

  function remove(index: number): void {
    items = items.filter((_, itemIndex) => itemIndex !== index);
  }
</script>

<section class="space-y-3 {className}">
  <div class="flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-medium">{t(title)}</h3>
      <p class="mt-0.5 text-xs text-muted-foreground">{t(description)}</p>
    </div>
    <Button type="button" variant="outline" size="sm" onclick={add}>
      <Plus class="size-3.5" />{t('添加变量')}
    </Button>
  </div>

  <div class="space-y-2">
    {#if items.length && layout === 'wide'}
      <div
        class="hidden grid-cols-[minmax(8rem,0.7fr)_minmax(12rem,1.3fr)_5rem_2rem] gap-2 px-3 text-xs text-muted-foreground sm:grid"
      >
        <span>{t('名称')}</span><span>{t('值')}</span><span>{t('敏感值')}</span><span></span>
      </div>
    {/if}
    {#each items as item, index (`${index}`)}
      <div
        class="grid gap-2 rounded-md border border-border p-3 {layout === 'wide'
          ? 'sm:grid-cols-[minmax(8rem,0.7fr)_minmax(12rem,1.3fr)_5rem_2rem] sm:items-center'
          : ''}"
      >
        <label class="min-w-0 space-y-1">
          <span class="text-xs text-muted-foreground {layout === 'wide' ? 'sm:hidden' : ''}">{t('名称')}</span>
          <Input bind:value={item.name} placeholder="NAME" aria-label={t('环境变量名称')} />
        </label>
        <label class="min-w-0 space-y-1">
          <span class="text-xs text-muted-foreground {layout === 'wide' ? 'sm:hidden' : ''}">{t('值')}</span>
          <Input
            bind:value={item.value}
            type={item.secret ? 'password' : 'text'}
            placeholder={t('值')}
            aria-label={t('环境变量值')}
          />
        </label>
        <label class="flex h-8 items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" bind:checked={item.secret} />{t('敏感值')}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="text-destructive"
          aria-label={t('删除环境变量')}
          onclick={() => remove(index)}><Trash2 class="size-3.5" /></Button
        >
      </div>
    {:else}
      <p class="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">{t('未配置环境变量')}</p>
    {/each}
  </div>
</section>
