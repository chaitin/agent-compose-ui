<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t } from '$lib/i18n.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';

  let {
    query,
    count,
    active,
    onQuery,
    onPrevious,
    onNext,
  }: {
    query: string;
    count: number;
    active: number;
    onQuery: (value: string) => void;
    onPrevious: () => void;
    onNext: () => void;
  } = $props();
</script>

<div class="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2">
  <Input
    value={query}
    oninput={(event) => onQuery(event.currentTarget.value)}
    onkeydown={(event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }}
    class="min-w-0 flex-1 border-white/15 bg-white/5 text-white placeholder:text-white/35 sm:max-w-sm"
    placeholder={t('搜索当前对话')}
  />
  <span class="min-w-14 text-center text-xs text-white/45">{count ? `${active + 1} / ${count}` : '0 / 0'}</span>
  <Button
    size="sm"
    variant="ghost"
    class="size-8 border border-white/15 px-0 text-white/70 hover:bg-white/10 hover:text-white sm:w-auto sm:px-3"
    disabled={!count}
    aria-label={t('上一个')}
    title={t('上一个')}
    onclick={onPrevious}><ChevronUp class="size-3.5" /><span class="hidden sm:inline">{t('上一个')}</span></Button
  >
  <Button
    size="sm"
    variant="ghost"
    class="size-8 border border-white/15 px-0 text-white/70 hover:bg-white/10 hover:text-white sm:w-auto sm:px-3"
    disabled={!count}
    aria-label={t('下一个')}
    title={t('下一个')}
    onclick={onNext}><ChevronDown class="size-3.5" /><span class="hidden sm:inline">{t('下一个')}</span></Button
  >
</div>
