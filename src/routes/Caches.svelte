<script lang="ts">
  import { onMount } from 'svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import { Button } from '$lib/components/ui/button';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { timestampToISOString } from '../model/timestamps';
  import { listCaches, pruneUnusedCaches, removeCache } from '../api/resources';
  import type { CacheItem } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { t } from '$lib/i18n.svelte';
  let items = $state<CacheItem[]>([]);
  let warnings = $state<string[]>([]);
  let loading = $state(true);
  let error = $state('');
  const msg = (e: unknown) => (e instanceof Error ? e.message : t('请求失败'));
  onMount(load);
  async function load() {
    loading = true;
    error = '';
    try {
      const r = await listCaches();
      items = r.items;
      warnings = r.warnings;
    } catch (e) {
      error = msg(e);
    } finally {
      loading = false;
    }
  }
  async function remove(item: CacheItem) {
    if (!confirm(`确认删除缓存 ${item.cacheId}？`)) return;
    try {
      await removeCache(item.cacheId);
      await load();
    } catch (e) {
      error = msg(e);
    }
  }
  async function prune() {
    if (!confirm('确认清理 daemon 判定为未使用的缓存？')) return;
    try {
      const r = await pruneUnusedCaches(true);
      alert(`已删除 ${r.removed.length} 个，跳过 ${r.skipped.length} 个`);
      await load();
    } catch (e) {
      error = msg(e);
    }
  }
  const size = (v: bigint) => `${(Number(v) / 1024 / 1024).toFixed(1)} MB`;
</script>

<PageHeader title="缓存" description="运行时、镜像与 Skill 缓存"
  >{#snippet actions()}<Button variant="outline" size="sm" onclick={prune}>{t('清理未使用缓存')}</Button><Button
      variant="outline"
      size="sm"
      onclick={load}>{t('刷新')}</Button
    >{/snippet}</PageHeader
>
<PageContent class="space-y-3">
  {#if error}<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>{/if}{#if warnings.length}<div class="rounded-md bg-warning/10 p-3 text-sm text-warning">
      {warnings.join(' · ')}
    </div>{/if}{#if loading}<p class="text-sm text-muted-foreground">{t('正在加载…')}</p>{:else}<div
      class="overflow-hidden rounded-lg border border-border"
    >
      <table class="w-full text-sm">
        <thead class="bg-muted/40"
          ><tr
            ><th class="p-3 text-left">{t('缓存')}</th><th class="p-3 text-left">{t('类型')}</th><th
              class="p-3 text-left">{t('大小')}</th
            ><th class="p-3 text-left">{t('最后使用')}</th><th class="p-3 text-left">{t('状态')}</th><th></th></tr
          ></thead
        ><tbody class="divide-y divide-border"
          >{#each items as item (item.cacheId)}<tr
              ><td class="max-w-80 p-3"
                ><CopyableText value={item.cacheId} label="缓存 ID" class="max-w-full font-mono text-xs" />
                {#if item.path || item.imageRef}<CopyableText
                    value={item.path || item.imageRef}
                    label={item.path ? '缓存路径' : '镜像引用'}
                    class="mt-1 max-w-full text-xs text-muted-foreground"
                  />{/if}</td
              ><td class="p-3">{item.kind} · {item.driver}</td><td class="p-3">{size(item.sizeBytes)}</td><td
                class="p-3 text-xs text-muted-foreground"
                ><Timestamp value={timestampToISOString(item.lastUsedAt)} empty={t('从未使用')} /></td
              ><td class="p-3"
                >{item.status}{#if item.blockedReasons.length}<div class="text-xs text-warning">
                    {item.blockedReasons.join(' · ')}
                  </div>{/if}</td
              ><td class="p-3 text-right"
                ><Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive"
                  disabled={!item.removable}
                  onclick={() => remove(item)}>{t('删除')}</Button
                ></td
              ></tr
            >{:else}<tr><td colspan="6" class="p-8 text-center text-muted-foreground">{t('没有缓存')}</td></tr
            >{/each}</tbody
        >
      </table>
    </div>{/if}
</PageContent>
