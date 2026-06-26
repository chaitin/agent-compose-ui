<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';

  import { getCapabilityStatus } from '../api/config';
  import { listAgentDefinitions } from '../api/agents';
  import { listAutomationTasks, listRecentAutomationRuns } from '../api/loaders';
  import { listWorkSessions } from '../api/sessions';
  import { mapSessionStatus, mapLoaderRunStatus, statusTone } from '../model/runs';
  import { formatBeijingTime } from '../time';

  const dispatch = createEventDispatcher<{
    navigate: 'runs' | 'agents' | 'automation-tasks' | 'settings';
    openRun: string;
  }>();

  let loading = true;
  let error = '';
  let agentCount = 0;
  let taskCount = 0;
  let runCount = 0;
  let capabilityCount = 0;
  let attentionCount = 0;
  let recentItems: Array<{ id: string; title: string; type: string; status: string; at: string }> = [];
  let timelineRange: '12h' | '24h' | '36h' | '48h' | 'custom' = '24h';
  let customFrom = '';
  let customTo = '';

  $: attentionItems = recentItems.filter((item) => isAttentionStatus(item.status));
  $: timelineItems = recentItems
    .filter((item) => inTimelineRange(item.at))
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const [agents, sessions, tasks, capabilityStatus] = await Promise.all([
        listAgentDefinitions(),
        listWorkSessions(5).then((r) => r.sessions),
        listAutomationTasks(),
        getCapabilityStatus().catch(() => null),
      ]);
      agentCount = agents.length;
      taskCount = tasks.length;
      const runs = await listRecentAutomationRuns(tasks.map((item) => item.id), 5);
      runCount = sessions.length + runs.length;
      recentItems = [
        ...sessions.map((item) => ({ id: item.id, title: item.title || item.id, type: '工作会话', status: mapSessionStatus(item.status), at: item.updatedAt || item.createdAt })),
        ...runs.map((item) => ({ id: item.id, title: item.id, type: '自动化运行', status: mapLoaderRunStatus(item.status), at: item.completedAt || item.startedAt })),
      ].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime()).slice(0, 6);
      attentionCount = recentItems.filter((item) => isAttentionStatus(item.status)).length;
      capabilityCount = capabilityStatus?.serviceCount ?? 0;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function isRunningStatus(status: string): boolean {
    return /RUNNING|running|运行中/i.test(status);
  }

  function isAttentionStatus(status: string): boolean {
    return /FAILED|failed|失败|异常|cancel|取消/i.test(status);
  }

  function inTimelineRange(value: string): boolean {
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) {
      return false;
    }
    if (timelineRange === 'custom') {
      const from = customFrom ? new Date(customFrom).getTime() : Number.NaN;
      const to = customTo ? new Date(customTo).getTime() : Number.NaN;
      if (!Number.isNaN(from) && timestamp < from) return false;
      if (!Number.isNaN(to) && timestamp > to) return false;
      return true;
    }
    const hours = Number.parseInt(timelineRange, 10);
    return timestamp >= Date.now() - hours * 60 * 60 * 1000;
  }

  function formatTime(value: string): string {
    return formatBeijingTime(value);
  }

  function toLocalInput(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function setRange(range: typeof timelineRange): void {
    timelineRange = range;
    // Prefill the custom range with the last 24h so the inputs aren't blank
    // (matches the default 24h window); keep whatever the user already typed.
    if (range === 'custom' && !customFrom && !customTo) {
      const now = new Date();
      customTo = toLocalInput(now);
      customFrom = toLocalInput(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    }
  }
</script>

{#if error}
  <div class="alert danger">{error}</div>
{/if}

<div class="workspace-home">
  <section class="home-commandbar">
    <div class="command-metrics">
      <button on:click={() => dispatch('navigate', 'agents')}><span>智能体</span><b>{agentCount}</b></button>
      <button on:click={() => dispatch('navigate', 'automation-tasks')}><span>任务</span><b>{taskCount}</b></button>
      <button on:click={() => dispatch('navigate', 'runs')}><span>近期运行</span><b>{runCount}</b></button>
      <button on:click={() => dispatch('navigate', 'settings')}><span>能力</span><b>{capabilityCount}</b></button>
      <button class:attention={attentionCount > 0} on:click={() => dispatch('navigate', 'runs')}><span>需关注</span><b>{attentionCount}</b></button>
    </div>
    <div class="command-actions">
      <button on:click={load}>{loading ? '刷新中...' : '刷新概览'}</button>
    </div>
  </section>

  <div class="home-split">
    <section class="home-panel">
      <div class="home-panel-title">
        <h2>近期时间轴</h2>
        <div class="radio-range">
          {#each ['12h', '24h', '36h', '48h'] as range}
            <button class:active={timelineRange === range} on:click={() => setRange(range as typeof timelineRange)}><span></span>{range.toUpperCase()}</button>
          {/each}
          <button class:active={timelineRange === 'custom'} on:click={() => setRange('custom')}><span></span>自定义</button>
        </div>
      </div>
      {#if timelineRange === 'custom'}
        <div class="inline-fields">
          <label>开始<input type="datetime-local" bind:value={customFrom}></label>
          <label>结束<input type="datetime-local" bind:value={customTo}></label>
        </div>
      {/if}
      {#if timelineItems.length === 0}
        <div class="empty">暂无时间轴数据。</div>
      {:else}
        <div class="timeline-list">
          {#each timelineItems as item}
            <button class="timeline-item" on:click={() => dispatch('openRun', item.id)}>
              <span class="timeline-dot" class:red={isAttentionStatus(item.status)} class:blue={isRunningStatus(item.status)}></span>
              <span><b>{item.title}</b><small>{formatTime(item.at)} · {item.type}</small></span>
              <span class={`home-pill ${statusTone(item.status)}`}>{item.status || '-'}</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <section class="home-panel">
      <div class="home-panel-title">
        <h2>失败 / 异常</h2>
        <p>{attentionCount} 项需关注</p>
      </div>
      {#if attentionItems.length === 0}
        <div class="empty">暂无异常运行。</div>
      {:else}
        <div class="attention-list">
          {#each attentionItems as item}
            <button class="attention-item" on:click={() => dispatch('openRun', item.id)}>
              <span><b>{item.title}</b><small>{item.type} · {item.id}</small></span>
              <span class={`home-pill ${statusTone(item.status)}`}>{item.status}</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>
