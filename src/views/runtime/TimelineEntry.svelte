<script lang="ts">
  import type { Snippet } from 'svelte';
  import { runtimeTimelineLabels, type RuntimeTimelineEntry } from '../../lib/runtime-timeline';
  import type { FullExecutionTimelineEntry } from '../../lib/scheduler-full-timeline';
  import type { SandboxTimelineEntry } from '../../lib/sandbox-detail';
  import { store } from '../../lib/stores.svelte';
  import { copyText } from '../../lib/clipboard';

  // 同时兼容两种条目:
  //  - RuntimeTimelineEntry(单次运行时间线,无 raw / sourceType)
  //  - FullExecutionTimelineEntry(调度全链路时间线,带 raw / sourceType / sourceId / parentSourceIds)
  let {
    entry,
    collapseAfterLines,
    lead,
    trailing,
  }: {
    entry: RuntimeTimelineEntry | FullExecutionTimelineEntry | SandboxTimelineEntry;
    collapseAfterLines?: number;
    lead?: Snippet<[]>;
    trailing?: Snippet<[]>;
  } = $props();

  let expanded = $state(false);
  let expandedSections = $state<Record<number, boolean>>({});
  let overflowing = $state(false);
  let rawOpen = $state(false);

  let label = $derived('label' in entry
    ? (entry.kind === 'cell' ? 'CELL' : entry.kind === 'sandbox' ? 'SANDBOX' : 'RUN')
    : runtimeTimelineLabels[entry.kind]);
  // 单 run 条目没有 raw,回退用 content,保证"查看完整原始数据"在两种页面都可用。
  let raw = $derived('raw' in entry && entry.raw ? entry.raw : entry.content);
  let sourceType = $derived('sourceType' in entry ? entry.sourceType : '');
  let sourceId = $derived('sourceId' in entry ? entry.sourceId : '');
  let parentIds = $derived('parentSourceIds' in entry ? entry.parentSourceIds : []);
  let sourceCode = $derived(sourceType ? `${sourceType}:${sourceId}` : '');
  let sections = $derived('sections' in entry ? entry.sections : undefined);
  let isError = $derived(entry.level === 'error');
  let isWarning = $derived(entry.level === 'warning');
  let exceedsLineLimit = $derived(collapseAfterLines !== undefined
    && entry.content.split('\n').length > collapseAfterLines);
  let collapsible = $derived(collapseAfterLines === undefined ? overflowing : exceedsLineLimit);

  // 折叠态下检测内容是否溢出 ~20 行(32em),溢出才显示"展示全部"按钮。
  function overflowAction(node: HTMLElement, isExpanded: boolean) {
    if (collapseAfterLines !== undefined) return { update() {}, destroy() {} };
    let frame = 0;
    let expandedNow = isExpanded;
    const measure = () => {
      overflowing = !expandedNow && node.scrollHeight > node.clientHeight + 1;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    schedule();
    return {
      update(next: boolean) { expandedNow = next; schedule(); },
      destroy() { cancelAnimationFrame(frame); observer.disconnect(); },
    };
  }

  function toggle() { expanded = !expanded; }
  function toggleSection(index: number) { expandedSections[index] = !expandedSections[index]; }
  function sectionExceedsLimit(content: string) { return content.split('\n').length > 20; }

  async function copyContent() {
    try { await copyText(entry.content); store.addToast('已复制全文', 'success'); }
    catch { store.addToast('复制失败', 'error'); }
  }
</script>

<div class="entry-body" class:error={isError} class:warning={isWarning}>
  <header>
    <strong>{label}</strong>
    <span>{entry.source}</span>
    {#if sourceCode}<code>{sourceCode}</code>{/if}
    {#each parentIds as parentId}<code>{parentId}</code>{/each}
    <button class="copy-icon" aria-label={`复制全文：${sourceCode || label}`} title="复制全文" onclick={copyContent}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" /></svg>
    </button>
  </header>
  {#if lead}{@render lead()}{/if}
  {#if sections?.length}
    <div class="entry-sections">
      {#each sections as section, index}
        <section class="entry-section">
          <strong>{section.label}</strong>
          <pre class="section-content" class:collapsed={section.collapsible && sectionExceedsLimit(section.content) && !expandedSections[index]}>{section.content}</pre>
          {#if section.collapsible && sectionExceedsLimit(section.content)}
            <button class="entry-toggle" aria-label={`${expandedSections[index] ? '收起' : '展开'}${section.label}`} aria-expanded={Boolean(expandedSections[index])} onclick={() => toggleSection(index)}>{expandedSections[index] ? '收起' : '展开'}<span class="entry-toggle-icon" aria-hidden="true">{expandedSections[index] ? '↑' : '↓'}</span></button>
          {/if}
        </section>
      {/each}
    </div>
  {:else}
    <pre class="entry-content" class:collapsed={!expanded && (collapseAfterLines === undefined || collapsible)} use:overflowAction={expanded}>{entry.content}</pre>
    {#if collapsible}<button class="entry-toggle" aria-expanded={expanded} onclick={toggle}>{expanded ? '收起' : '展示全部'}<span class="entry-toggle-icon" aria-hidden="true">{expanded ? '↑' : '↓'}</span></button>{/if}
  {/if}
  {#if trailing}{@render trailing()}{/if}
  <details bind:open={rawOpen}>
    <summary>查看完整原始数据</summary>
    {#if rawOpen}
      <pre class="raw">{raw}</pre>
    {/if}
  </details>
</div>

<style>
  .entry-body { min-width: 0; padding: 10px; border-left: 1px solid var(--border-color); }
  header { display: flex; gap: 8px; align-items: center; color: var(--accent-blue); font: var(--font-size-xs) var(--font-mono); }
  header span { color: var(--text-secondary); }
  header code { overflow-wrap: anywhere; color: var(--text-muted); }
  .entry-body.error header { color: var(--accent-red); }
  .entry-body.warning header { color: var(--accent-yellow); }
  .copy-icon { margin-left: auto; display: inline-grid; place-items: center; padding: 3px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-muted); line-height: 0; cursor: pointer; }
  .copy-icon svg { width: 11px; height: 11px; fill: currentColor; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: var(--font-size-sm)/1.6 var(--font-mono); margin: 7px 0 0; }
  .entry-content.collapsed { max-height: 32em; overflow: hidden; }
  .entry-sections { display: grid; gap: 0; margin-top: 8px; border: 1px solid var(--border-color); border-radius: 4px; }
  .entry-section { min-width: 0; padding: 8px 9px; border-bottom: 1px solid var(--border-color); }
  .entry-section:last-child { border-bottom: 0; }
  .entry-section > strong { display: block; color: var(--text-muted); font: var(--font-size-xs)/1.3 var(--font-mono); }
  .section-content { margin-top: 5px; }
  .section-content.collapsed { max-height: 32em; overflow: hidden; }
  .entry-toggle { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; padding: 3px 7px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-tertiary); color: var(--text-muted); font: var(--font-size-xs)/1.4 var(--font-mono); cursor: pointer; }
  .entry-toggle:hover { border-color: var(--accent-blue); color: var(--accent-blue); }
  .entry-toggle:active { transform: translateY(1px); }
  .entry-toggle:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 2px; }
  .entry-toggle-icon { font-size: 10px; line-height: 1; }
  details { margin-top: 8px; color: var(--text-muted); font-size: var(--font-size-xs); }
  pre.raw { margin-top: 6px; }
  :global(.te-lead-note) { display: block; color: var(--text-muted); font-size: var(--font-size-xs); margin: 4px 0 0; }
  :global(.te-entry-actions) { display: flex; gap: 5px; margin-top: 6px; }
  :global(.te-entry-actions button) { padding: 3px 6px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-muted); font-size: var(--font-size-xs); cursor: pointer; }
</style>
