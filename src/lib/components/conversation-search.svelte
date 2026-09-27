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

<div class="flex shrink-0 items-center gap-2 border-b border-border bg-transparent px-3 py-2">
  <Input
    value={query}
    oninput={(event) => onQuery(event.currentTarget.value)}
    onkeydown={(event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }}
    class="min-w-0 flex-1 border-input bg-muted text-foreground placeholder:text-faint sm:max-w-sm"
    placeholder={t('搜索当前对话')}
  />
  <span class="min-w-14 text-center text-xs text-faint">{count ? `${active + 1} / ${count}` : '0 / 0'}</span>
  <Button
    size="sm"
    variant="ghost"
    class="size-8 border border-input px-0 text-muted-foreground hover:bg-muted hover:text-foreground sm:w-auto sm:px-3"
    disabled={!count}
    aria-label={t('上一个')}
    title={t('上一个')}
    onclick={onPrevious}><ChevronUp class="size-3.5" /><span class="hidden sm:inline">{t('上一个')}</span></Button
  >
  <Button
    size="sm"
    variant="ghost"
    class="size-8 border border-input px-0 text-muted-foreground hover:bg-muted hover:text-foreground sm:w-auto sm:px-3"
    disabled={!count}
    aria-label={t('下一个')}
    title={t('下一个')}
    onclick={onNext}><ChevronDown class="size-3.5" /><span class="hidden sm:inline">{t('下一个')}</span></Button
  >
</div>
