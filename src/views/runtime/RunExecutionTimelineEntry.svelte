<script lang="ts">
  import type { Snippet } from 'svelte';
  import { runtimeTimelineLabels, type RuntimeTimelineEntry } from '../../lib/runtime-timeline';
  import { store } from '../../lib/stores.svelte';
  import { copyText } from '../../lib/clipboard';

  let { entry, lead, trailing, onOpenArtifact }: {
    entry: RuntimeTimelineEntry;
    lead?: Snippet<[]>;
    trailing?: Snippet<[]>;
    onOpenArtifact?: (target: { sandboxId: string; path: string }) => void;
  } = $props();
  let expanded = $state(false);
  let overflowing = $state(false);
  let rawOpen = $state(false);
  let label = $derived(runtimeTimelineLabels[entry.kind]);

  function overflowAction(node: HTMLElement, isExpanded: boolean) {
    let frame = 0;
    let expandedNow = isExpanded;
    const measure = () => { overflowing = !expandedNow && node.scrollHeight > node.clientHeight + 1; };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    schedule();
    return {
      update(next: boolean) { expandedNow = next; schedule(); },
      destroy() { cancelAnimationFrame(frame); observer.disconnect(); },
    };
  }

  async function copy(content: string, success: string) {
    try { await copyText(content); store.addToast(success, 'success'); }
    catch { store.addToast('复制失败', 'error'); }
  }
</script>

<div class="entry-body" class:error={entry.level === 'error'} class:warning={entry.level === 'warning'}>
  <header>
    <strong>{label}</strong>
    <span>{entry.source}</span>
    <button class="copy-icon" aria-label={`复制全文：${label}`} title="复制全文" onclick={() => copy(entry.content, '已复制全文')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" /></svg>
    </button>
  </header>
  {#if lead}{@render lead()}{/if}
  <pre class="entry-content" class:collapsed={!expanded} use:overflowAction={expanded}>{entry.content}</pre>
  {#if entry.artifactTarget}
    <button class="artifact-link" aria-label={`打开 Workspace 文件 ${entry.artifactTarget.path}`} onclick={() => onOpenArtifact?.(entry.artifactTarget!)}>{entry.artifactTarget.path}</button>
  {/if}
  {#if overflowing}<button class="entry-toggle" aria-expanded={expanded} onclick={() => expanded = !expanded}>{expanded ? '收起' : '展示全部'}<span class="entry-toggle-icon" aria-hidden="true">{expanded ? '↑' : '↓'}</span></button>{/if}
  {#if trailing}{@render trailing()}{/if}
  <details bind:open={rawOpen}>
    <summary>查看完整原始数据</summary>
    {#if rawOpen}
      <pre class="raw">{entry.content}</pre>
    {/if}
  </details>
</div>

<style>
  .entry-body { min-width:0; padding:10px; border-left:1px solid var(--border-color); }
  header { display:flex; gap:8px; align-items:center; color:var(--accent-blue); font:var(--font-size-xs) var(--font-mono); } header span { color:var(--text-secondary); }
  .entry-body.error header { color:var(--accent-red); }.entry-body.warning header { color:var(--accent-yellow); }
  .copy-icon { margin-left:auto; display:inline-grid; place-items:center; padding:3px; border:1px solid var(--border-color); border-radius:3px; background:var(--bg-tertiary); color:var(--text-muted); line-height:0; cursor:pointer; }.copy-icon svg { width:11px; height:11px; fill:currentColor; }
  pre { margin:7px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text-secondary); font:var(--font-size-sm)/1.6 var(--font-mono); }.entry-content.collapsed { max-height:32em; overflow:hidden; }
  .entry-toggle { display:inline-flex; align-items:center; gap:4px; margin-top:6px; padding:3px 7px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-tertiary); color:var(--text-muted); font:var(--font-size-xs)/1.4 var(--font-mono); cursor:pointer; }
  .entry-toggle:hover { border-color:var(--accent-blue); color:var(--accent-blue); }
  .entry-toggle:active { transform:translateY(1px); }
  .entry-toggle:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }
  .entry-toggle-icon { font-size:10px; line-height:1; }
  .artifact-link { display:block; margin-top:6px; padding:0; border:0; background:transparent; color:var(--accent-blue); font:var(--font-size-sm) var(--font-mono); cursor:pointer; text-align:left; overflow-wrap:anywhere; }
  .artifact-link:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }
  details { margin-top:8px; color:var(--text-muted); font-size:var(--font-size-xs); } pre.raw { margin-top:6px; }
  :global(.te-lead-note) { display:block; margin:4px 0 0; color:var(--text-muted); font-size:var(--font-size-xs); }
  :global(.te-entry-actions) { display:flex; gap:5px; margin-top:6px; }:global(.te-entry-actions button) { padding:3px 6px; border:1px solid var(--border-color); border-radius:3px; background:var(--bg-tertiary); color:var(--text-muted); font-size:var(--font-size-xs); cursor:pointer; }
</style>
