<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';

  import type { WorkSessionCell } from '../api/sessions';
  import {
    findSessionOutputMatches,
    isAgentSessionCell,
    sessionCellStatus,
    sessionCellStatusTone,
    sessionMessageOutput,
    sessionMessageSource,
    sessionOutputMatchParts,
    sessionOutputText,
    visibleSessionCells,
    type SessionOutputSearchMatch,
  } from '../model/session-output';
  import { formatBeijingTime } from '../time';

  export let sessionId = '';
  export let cells: WorkSessionCell[] = [];
  export let refreshing = false;
  export let refreshDisabled = false;
  export let resetVersion = 0;
  export let refresh: () => Promise<void>;

  type SearchState = {
    query: string;
    appliedQuery: string;
    matches: SessionOutputSearchMatch[];
    currentIndex: number;
    locateCurrent: boolean;
  };

  const SEARCH_DEBOUNCE_MS = 500;
  const MIN_SEARCH_QUERY_LENGTH = 2;

  let search: SearchState = { query: '', appliedQuery: '', matches: [], currentIndex: -1, locateCurrent: false };
  let copyFeedback = '';
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let cellListElement: HTMLElement | null = null;
  let currentMatchElement: HTMLElement | null = null;
  let mounted = false;
  let previousCells = cells;
  let previousResetVersion = resetVersion;
  let visibleCells: WorkSessionCell[] = [];

  $: visibleCells = visibleSessionCells(cells);
  $: if (mounted && resetVersion !== previousResetVersion) {
    previousResetVersion = resetVersion;
    resetOutputState();
  }
  $: if (mounted && cells !== previousCells) {
    previousCells = cells;
    updateSearchOrScroll();
  }

  onMount(() => {
    mounted = true;
    previousCells = cells;
    previousResetVersion = resetVersion;
    void scrollToBottom();
  });

  onDestroy(() => {
    cancelSearch();
    if (copyTimer) clearTimeout(copyTimer);
  });

  function formatTime(value: string): string {
    return value ? formatBeijingTime(value) : '-';
  }

  async function scrollToBottom(): Promise<void> {
    await tick();
    if (cellListElement) cellListElement.scrollTop = cellListElement.scrollHeight;
  }

  function updateSearchOrScroll(): void {
    if (isSearchableQuery(search.query)) scheduleSearch(search.query, search.locateCurrent);
    if (!search.locateCurrent) void scrollToBottom();
  }

  function cancelSearch(): void {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
  }

  function resetOutputState(): void {
    cancelSearch();
    search = { query: '', appliedQuery: '', matches: [], currentIndex: -1, locateCurrent: false };
    currentMatchElement = null;
    copyFeedback = '';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = null;
    void scrollToBottom();
  }

  function scheduleSearch(query: string, locateCurrent = true): void {
    const normalizedQuery = query.trim();
    const searchable = isSearchableQuery(normalizedQuery);
    const queryChanged = normalizedQuery !== search.appliedQuery;
    search = searchable
      ? { ...search, query, currentIndex: queryChanged ? -1 : search.currentIndex, locateCurrent }
      : { query, appliedQuery: '', matches: [], currentIndex: -1, locateCurrent: false };
    cancelSearch();
    if (!searchable) return;
    searchTimer = setTimeout(() => {
      searchTimer = null;
      applySearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  function applySearch(preferredMatch?: SessionOutputSearchMatch): void {
    if (!isSearchableQuery(search.query)) return;
    const matches = findSessionOutputMatches(cells, search.query);
    const preferredIndex = preferredMatch
      ? matches.findIndex((match) => matchKey(match) === matchKey(preferredMatch))
      : -1;
    const currentIndex = matches.length === 0
      ? -1
      : preferredIndex >= 0
        ? preferredIndex
        : Math.min(Math.max(search.currentIndex, 0), matches.length - 1);
    search = { ...search, appliedQuery: search.query.trim(), matches, currentIndex };
    if (currentIndex >= 0 && search.locateCurrent) void scrollToMatch();
  }

  function isSearchableQuery(query: string): boolean {
    return Array.from(query.trim()).length >= MIN_SEARCH_QUERY_LENGTH;
  }

  function moveSearch(direction: -1 | 1): void {
    const applyingNewQuery = search.query.trim() !== search.appliedQuery;
    if (searchTimer) {
      cancelSearch();
      applySearch();
      if (applyingNewQuery) return;
    }
    if (search.matches.length === 0) return;
    const currentIndex = (search.currentIndex + direction + search.matches.length) % search.matches.length;
    search = { ...search, currentIndex, locateCurrent: true };
    void scrollToMatch();
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      moveSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      scheduleSearch('');
    }
  }

  function matchKey(match: SessionOutputSearchMatch): string {
    return `${match.cellId}\u0000${match.section}\u0000${match.lineIndex}`;
  }

  function registerCurrentMatch(node: HTMLElement): { destroy: () => void } {
    currentMatchElement = node;
    return { destroy: () => { if (currentMatchElement === node) currentMatchElement = null; } };
  }

  async function scrollToMatch(): Promise<void> {
    await tick();
    currentMatchElement?.scrollIntoView({ block: 'center' });
  }

  function sectionMatch(
    match: SessionOutputSearchMatch | undefined,
    cellId: string,
    section: SessionOutputSearchMatch['section'],
  ): SessionOutputSearchMatch | undefined {
    return match?.cellId === cellId && match.section === section ? match : undefined;
  }

  async function refreshOutput(): Promise<void> {
    if (refreshDisabled) return;
    cancelSearch();
    const preferredMatch = search.matches[search.currentIndex];
    search = { ...search, locateCurrent: false };
    try {
      await refresh();
      await tick();
      cancelSearch();
      if (isSearchableQuery(search.query)) applySearch(preferredMatch);
      await scrollToBottom();
    } catch {
      // The page owns and displays the request error; keep the current output.
    }
  }

  async function copyAll(): Promise<void> {
    try {
      await writeClipboardText(sessionOutputText(cells));
      copyFeedback = '已复制';
    } catch {
      copyFeedback = '复制失败';
    }
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyFeedback = ''; }, 1600);
  }

  async function writeClipboardText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('复制失败');
  }
</script>

<div class="session-output">
  <div class="session-output-head">
    <h4>会话输出</h4>
    <div class="session-output-toolbar" aria-label={`会话 ${sessionId} 输出操作`}>
      <label class="output-search-field">
        <span class="visually-hidden">搜索会话输出</span>
        <input type="search" value={search.query} placeholder="搜索输出（至少 2 个字符）" disabled={visibleCells.length === 0} on:input={(event) => scheduleSearch(event.currentTarget.value)} on:keydown={handleSearchKeydown}>
      </label>
      <span class="search-count" aria-live="polite">{search.matches.length > 0 ? `${search.currentIndex + 1}/${search.matches.length}` : '0/0'}</span>
      <button type="button" class="compact-button" disabled={search.matches.length === 0} on:click={() => moveSearch(-1)}>上一个</button>
      <button type="button" class="compact-button" disabled={search.matches.length === 0} on:click={() => moveSearch(1)}>下一个</button>
      <button type="button" class="compact-button" disabled={refreshDisabled} on:click={refreshOutput}>{refreshing ? '刷新中...' : '刷新'}</button>
      <button type="button" class="compact-button" disabled={visibleCells.length === 0} on:click={copyAll}>{copyFeedback || '拷贝全部'}</button>
    </div>
  </div>

  {#if visibleCells.length > 0}
    <div class="cell-list message-stack" bind:this={cellListElement}>
      {#each visibleCells as cell}
        {@const source = sessionMessageSource(cell)}
        {@const output = sessionMessageOutput(cell)}
        {@const sourceMatch = sectionMatch(search.matches[search.currentIndex], cell.id, 'source')}
        {@const outputMatch = sectionMatch(search.matches[search.currentIndex], cell.id, 'output')}
        {#if source}
          <article class="message-card role-user">
            <div class="message-cell-head">
              <div class="message-cell-summary"><div class="message-title-row"><b>用户</b><span class="message-cell-id">{cell.id}</span></div></div>
              <div class="message-cell-meta"><span>{formatTime(cell.createdAt)}</span></div>
            </div>
            <pre class="message-source">{#if sourceMatch}{#each sessionOutputMatchParts(source, sourceMatch) as part}{#if part.matched}<mark class="output-match" use:registerCurrentMatch>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{source}{/if}</pre>
          </article>
        {/if}
        {#if output}
          <article class="message-card" class:failed={!cell.running && !cell.success} class:running={cell.running}>
            <div class="message-cell-head">
              <div class="message-cell-summary"><div class="message-title-row"><b>{cell.agent || '助手'}</b><span class="message-cell-id">{cell.id}</span><span class={`message-status ${sessionCellStatusTone(cell)}`}>{sessionCellStatus(cell)}</span></div></div>
              <div class="message-cell-meta"><span>{formatTime(cell.createdAt)}</span></div>
            </div>
            {#if isAgentSessionCell(cell)}
              <div class="run-terminal-block" class:running={cell.running}>
                <pre class="run-terminal-static">{#if outputMatch}{#each sessionOutputMatchParts(output, outputMatch) as part}{#if part.matched}<mark class="output-match" use:registerCurrentMatch>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{output}{/if}</pre>
              </div>
            {:else}
              <pre class="run-terminal-static">{#if outputMatch}{#each sessionOutputMatchParts(output, outputMatch) as part}{#if part.matched}<mark class="output-match" use:registerCurrentMatch>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{output}{/if}</pre>
            {/if}
          </article>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="empty">暂无会话输出。</div>
  {/if}
</div>

<style>
  .session-output {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 8px;
    min-height: 0;
    overflow: hidden;
  }

  .session-output-head,
  .session-output-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .session-output-head {
    justify-content: space-between;
    gap: 10px;
  }

  .session-output-toolbar { justify-content: flex-end; }
  h4 { margin: 0; color: var(--text); font-size: 13px; }
  .output-search-field { min-width: 120px; }

  .output-search-field input {
    box-sizing: border-box;
    width: clamp(120px, 16vw, 220px);
    min-height: 28px;
    padding: 4px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text);
    background: #fff;
    font: inherit;
    font-size: 12px;
  }

  .output-search-field input:focus { border-color: var(--primary); outline: 2px solid rgba(47, 95, 208, 0.14); }
  .search-count { min-width: 36px; color: var(--muted); font-family: var(--mono); font-size: 11px; text-align: center; }
  .compact-button { flex: 0 0 auto; min-height: 28px; padding: 5px 9px; font-size: 12px; }
  .cell-list { display: grid; gap: 8px; min-height: 0; overflow: auto; padding-right: 2px; }
  .message-card { gap: 6px; padding: 10px 12px; }
  .message-cell-head { gap: 10px; }
  .message-cell-meta { font-size: 11px; }
  .message-cell-id { display: inline-block; max-width: min(100%, 220px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }

  pre {
    margin: 0;
    overflow: visible;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #07111a;
    color: #d8e2ec;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .message-source { padding: 0; border: 0; border-radius: 0; background: transparent; color: #475569; line-height: 17px; overflow-wrap: anywhere; }
  .output-match { border-radius: 2px; background: #fa8c16; color: #172033; box-shadow: 0 0 0 2px rgba(250, 140, 22, 0.35); }
  .run-terminal-block { min-width: 0; overflow: hidden; }
  .run-terminal-block .run-terminal-static { overflow: visible; border: 0; border-radius: 0; background: transparent; }
  .message-card > .run-terminal-static { overflow: visible; }
  .empty { min-height: 0; display: grid; place-items: center; color: var(--muted); }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 960px) {
    .session-output-head,
    .session-output-toolbar { align-items: stretch; flex-wrap: wrap; justify-content: flex-start; }
    .session-output-head { flex-direction: column; }
    .output-search-field { flex: 1 1 180px; }
    .output-search-field input { width: 100%; }
  }
</style>
