<script lang="ts">
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t } from '$lib/i18n.svelte';

  let {
    actor = $bindable(''),
    action = $bindable(''),
    outcome = $bindable(''),
    resourceType = $bindable(''),
    resourceId = $bindable(''),
    from = $bindable(''),
    to = $bindable(''),
    loading = false,
    onSubmit,
  }: {
    actor?: string;
    action?: string;
    outcome?: string;
    resourceType?: string;
    resourceId?: string;
    from?: string;
    to?: string;
    loading?: boolean;
    onSubmit: () => void;
  } = $props();

  let advancedOpen = $state(false);
  const advancedCount = $derived([resourceType, resourceId, from, to].filter(Boolean).length);
</script>

<form
  class="rounded-lg border border-border bg-card p-3"
  onsubmit={(event) => {
    event.preventDefault();
    onSubmit();
  }}
>
  <div class="grid gap-2 md:grid-cols-[minmax(10rem,0.8fr)_minmax(14rem,1.2fr)_11rem_auto]">
    <Input bind:value={actor} placeholder={t('用户 ID')} aria-label={t('用户 ID')} />
    <Input bind:value={action} placeholder={t('操作或接口')} aria-label={t('操作或接口')} />
    <select
      bind:value={outcome}
      aria-label={t('结果')}
      class="h-8 rounded-lg border border-input bg-background px-2 text-sm"
    >
      <option value="">{t('全部结果')}</option>
      <option value="success">{t('成功')}</option>
      <option value="failure">{t('失败')}</option>
      <option value="denied">{t('拒绝')}</option>
      <option value="started">{t('进行中')}</option>
    </select>
    <div class="flex gap-2">
      <Button
        type="button"
        variant={advancedOpen || advancedCount ? 'secondary' : 'outline'}
        size="sm"
        class="flex-1 md:flex-none"
        aria-expanded={advancedOpen}
        onclick={() => (advancedOpen = !advancedOpen)}
      >
        <SlidersHorizontal class="size-3.5" />{t('更多筛选')}{#if advancedCount}
          <span class="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">{advancedCount}</span>
        {/if}
      </Button>
      <Button type="submit" size="sm" class="flex-1 md:flex-none" disabled={loading}>
        {t(loading ? '查询中…' : '查询')}
      </Button>
    </div>
  </div>

  {#if advancedOpen}
    <div class="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2 xl:grid-cols-4">
      <label class="space-y-1">
        <span class="text-xs text-muted-foreground">{t('资源类型')}</span>
        <Input bind:value={resourceType} placeholder={t('资源类型')} />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-muted-foreground">{t('资源 ID')}</span>
        <Input bind:value={resourceId} placeholder={t('资源 ID')} />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-muted-foreground">{t('开始时间')}</span>
        <Input bind:value={from} type="datetime-local" />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-muted-foreground">{t('结束时间')}</span>
        <Input bind:value={to} type="datetime-local" />
      </label>
    </div>
  {/if}
</form>
