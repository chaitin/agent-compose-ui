<script lang="ts">
  import { literalTextMatches } from '../../model/text-search';

  let {
    text,
    query,
    matchOffset = 0,
    activeMatch = -1,
  }: { text: string; query: string; matchOffset?: number; activeMatch?: number } = $props();

  const matches = $derived(literalTextMatches(text, query));
</script>

{#if matches.length}
  {#each matches as match, index (match.start)}{text.slice(index ? matches[index - 1].end : 0, match.start)}<mark
      data-conversation-match
      data-search-active={matchOffset + index === activeMatch ? 'true' : undefined}
      class="rounded-sm bg-amber-300 px-0.5 text-slate-950 data-[search-active=true]:bg-orange-500 data-[search-active=true]:text-white"
      >{text.slice(match.start, match.end)}</mark
    >{/each}{text.slice(matches[matches.length - 1].end)}
{:else}{text}{/if}
