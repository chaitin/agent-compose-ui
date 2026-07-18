<script lang="ts">
  import { untrack } from 'svelte';
  import { GetSandboxRequest, type Sandbox } from '../gen/agentcompose/v2/agentcompose_pb';
  import { loadEventSandboxLinks, type EventSandboxLink } from '../lib/event-sandbox-links';
  import { sandboxService } from '../lib/rpc';
  import SandboxDetailView from '../views/runtime/SandboxDetailView.svelte';

  let { eventId }: { eventId: string } = $props();

  interface EventSandboxOption {
    link: EventSandboxLink;
    sandbox: Sandbox;
  }

  let loading = $state(true);
  let error = $state('');
  let options = $state<EventSandboxOption[]>([]);
  let selectedSandboxId = $state('');
  let unavailableCount = $state(0);
  let generation = 0;
  let selected = $derived(options.find(option => option.sandbox.sandboxId === selectedSandboxId));

  $effect(() => {
    void eventId;
    untrack(() => { void load(); });
  });

  function timestamp(value?: { seconds: bigint; nanos: number }): number {
    return value ? Number(value.seconds) * 1000 + value.nanos / 1_000_000 : 0;
  }

  function linkTimestamp(link: EventSandboxLink): number {
    const parsed = Date.parse(link.createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function optionTimestamp(option: EventSandboxOption): number {
    return timestamp(option.sandbox.updatedAt) || timestamp(option.sandbox.createdAt) || linkTimestamp(option.link);
  }

  function querySelection(): string {
    return new URL(window.location.href).searchParams.get('sandboxId') || '';
  }

  async function load() {
    const current = ++generation;
    const retained = selectedSandboxId || querySelection();
    loading = true;
    error = '';
    unavailableCount = 0;
    try {
      const links = await loadEventSandboxLinks(eventId);
      const loaded = await Promise.all(links.map(async link => {
        try {
          const response = await sandboxService.getSandbox(new GetSandboxRequest({ sandboxId: link.sandboxId }));
          return response.sandbox ? { link, sandbox: response.sandbox } : null;
        } catch {
          return null;
        }
      }));
      if (current !== generation) return;
      unavailableCount = loaded.filter(item => item === null).length;
      options = loaded
        .filter((item): item is EventSandboxOption => item !== null)
        .sort((left, right) => optionTimestamp(right) - optionTimestamp(left) || left.sandbox.sandboxId.localeCompare(right.sandbox.sandboxId));
      selectedSandboxId = options.some(option => option.sandbox.sandboxId === retained)
        ? retained
        : options[0]?.sandbox.sandboxId || '';
    } catch (cause) {
      if (current !== generation) return;
      options = [];
      selectedSandboxId = '';
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (current === generation) loading = false;
    }
  }

  function statusLabel(value: string): string {
    const status = value.trim().toUpperCase();
    if (status === 'RUNNING') return '运行中';
    if (status === 'STOPPED') return '已停止';
    if (status === 'REMOVED' || status === 'DESTROYED') return '已销毁';
    return value || '状态未知';
  }

  function selectSession(event: Event) {
    selectedSandboxId = (event.currentTarget as HTMLSelectElement).value;
    const url = new URL(window.location.href);
    if (selectedSandboxId) url.searchParams.set('sandboxId', selectedSandboxId);
    else url.searchParams.delete('sandboxId');
    history.replaceState(null, '', `${url.pathname}${url.search}`);
  }
</script>

<div class="standalone-event-detail">
  <header class="session-strip">
    <div class="event-identity">
      <span>Event Session</span>
      <strong>{eventId}</strong>
    </div>
    {#if options.length}
      <label>
        <span>Session</span>
        <select aria-label="Session" value={selectedSandboxId} onchange={selectSession} disabled={loading}>
          {#each options as option}
            <option value={option.sandbox.sandboxId}>{option.sandbox.title || option.sandbox.sandboxId} · {statusLabel(option.sandbox.status)} · {option.sandbox.sandboxId}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button class="refresh" aria-label="刷新 Session" title="刷新 Session" onclick={load} disabled={loading}>↻</button>
  </header>

  {#if unavailableCount}
    <div class="notice warning">{unavailableCount} 个关联 Session 暂时无法加载</div>
  {/if}

  <main class="detail-region">
    {#if loading && !selected}
      <div class="state">加载 Event Session 中...</div>
    {:else if error}
      <div class="state error"><p>{error}</p><button onclick={load}>重试</button></div>
    {:else if !selected}
      <div class="state">该事件未关联 Session</div>
    {:else}
      <SandboxDetailView projectId={selected.sandbox.projectId} sandboxId={selected.sandbox.sandboxId} showBreadcrumb={false} />
    {/if}
  </main>
</div>

<style>
  .standalone-event-detail { display:grid; grid-template-rows:auto auto minmax(0,1fr); height:100%; min-height:0; background:var(--bg-primary); color:var(--text-primary); }
  .session-strip { display:grid; grid-template-columns:minmax(180px,.7fr) minmax(320px,1.3fr) auto; align-items:center; gap:14px; min-height:52px; padding:8px 14px; border-bottom:1px solid var(--border-color); background:var(--bg-secondary); }
  .event-identity { display:grid; min-width:0; gap:2px; }
  .event-identity span, label > span { color:var(--text-muted); font-size:var(--font-size-xs); font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
  .event-identity strong { overflow:hidden; color:var(--text-secondary); font:var(--font-size-xs) var(--font-mono); text-overflow:ellipsis; white-space:nowrap; }
  label { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:8px; min-width:0; }
  select { width:100%; min-width:0; padding:6px 28px 6px 9px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-primary); color:var(--text-primary); font:var(--font-size-xs) var(--font-mono); }
  select:focus-visible, button:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }
  button { border:1px solid var(--border-color); border-radius:4px; background:var(--bg-tertiary); color:var(--text-secondary); cursor:pointer; }
  button:disabled { cursor:not-allowed; opacity:.55; }
  .refresh { display:grid; width:28px; height:28px; place-items:center; padding:0; color:var(--accent-blue); font-size:15px; }
  .detail-region { grid-row:3; min-height:0; overflow:hidden; }
  .notice { padding:7px 14px; border-bottom:1px solid var(--border-color); font-size:var(--font-size-xs); }
  .notice.warning { color:var(--accent-yellow); }
  .state { display:grid; height:100%; place-content:center; gap:10px; color:var(--text-muted); text-align:center; }
  .state p { margin:0; }.state.error { color:var(--accent-red); }.state button { justify-self:center; padding:6px 10px; }
  @media (max-width:720px) { .session-strip { grid-template-columns:minmax(0,1fr) auto; }.event-identity { grid-column:1/-1; }label { grid-column:1; } }
</style>
