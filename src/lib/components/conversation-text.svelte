<script lang="ts">
  import SearchableText from '$lib/components/searchable-text.svelte';
  import { t } from '$lib/i18n.svelte';
  import { foldText, liveTail } from '../../model/text-fold';
  import { literalTextMatches, textMatchCount } from '../../model/text-search';

  // 对话里的智能体输出。长输出默认折叠中间部分，正在流式输出时只显示最后几十行，
  // 避免几万行文本整段进入页面、并在每个数据块到来时整段重新渲染。
  let {
    text,
    query,
    matchOffset = 0,
    activeMatch = -1,
    live = false,
  }: { text: string; query: string; matchOffset?: number; activeMatch?: number; live?: boolean } = $props();

  let expanded = $state(false);

  const fold = $derived(expanded ? null : live ? liveTail(text) : foldText(text));
  // 对话搜索按全文统计第几处匹配；关键词落在折叠部分时展开，保证计数和高亮对得上。
  const hiddenMatched = $derived(
    Boolean(fold && query.trim() && literalTextMatches(text.slice(fold.hiddenStart, fold.hiddenEnd), query).length),
  );
  const shown = $derived(hiddenMatched ? null : fold);
  const headMatches = $derived(shown ? textMatchCount(shown.head, query) : 0);
</script>

{#if !shown}<SearchableText {text} {query} {matchOffset} {activeMatch} />{:else}{#if shown.head}<SearchableText
      text={shown.head}
      {query}
      {matchOffset}
      {activeMatch}
    />{/if}<span
    data-text-fold
    class="my-1 block select-none rounded-md bg-muted px-3 py-1.5 font-sans text-xs text-muted-foreground"
    >{#if live}{t('前面还有 {count} 行，完整内容见「运行日志」', { count: shown.hiddenLines })}{:else}{t(
        '已折叠 {count} 行',
        { count: shown.hiddenLines },
      )}<button type="button" class="ml-2 text-primary hover:underline" onclick={() => (expanded = true)}
        >{t('展开全部')}</button
      >{/if}</span
  ><SearchableText text={shown.tail} {query} matchOffset={matchOffset + headMatches} {activeMatch} />{/if}
