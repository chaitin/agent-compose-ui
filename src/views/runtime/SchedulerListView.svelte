<script lang="ts">
  import { GetProjectRequest, GetSchedulerRequest, ListRunsRequest, ListSchedulerEventsRequest, RunAgentRequest, RunJupyterSpec, RunSandboxCleanupPolicy, RunSource, SetSchedulerEnabledRequest, SetSchedulerTriggerEnabledRequest, StartRunRequest, type ProjectScheduler, type ResolvedTrigger, type SchedulerEvent, type TriggerSpec } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { projectService, runService, runtimeProjectService } from '../../lib/rpc';
  import { store } from '../../lib/stores.svelte';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';
  import { assertManagedWorkspace } from '../../lib/workspace/preflight';

  type SchedulerRow = { sourceProjectId: string; summary: ProjectScheduler; triggers: TriggerSpec[]; resolvedTriggers: Record<string, ResolvedTrigger>; events: SchedulerEvent[]; eventsCursor: string; seenEventCursors: string[]; eventsLoading: boolean };
  let rows: SchedulerRow[] = $state([]);
  let payloads: Record<string, string> = $state({});
  type Overrides = { executionMode: 'wait' | 'detached'; sandboxId: string; driver: string; prompt: string; cleanupPolicy: RunSandboxCleanupPolicy; jupyterEnabled: boolean; jupyterExpose: boolean };
  let overrides: Record<string, Overrides> = $state({});
  let sandboxIds: string[] = $state([]);
  let loading = $state(true);
  let running = $state('');
  let controlling = $state('');
  let error = $state('');
  let loadGeneration = 0;

  async function load() {
    const projectId = store.activeProjectId;
    const generation = ++loadGeneration;
    rows = [];
    payloads = {};
    overrides = {};
    sandboxIds = [];
    running = '';
    controlling = '';
    error = '';
    if (!projectId) { loading = false; return; }
    loading = true;
    try {
      const [response, runResponse] = await Promise.all([
        runtimeProjectService.getProject(new GetProjectRequest({ project: { projectId }, includeSpec: true }), { timeoutMs: 30_000 }),
        runService.listRuns(new ListRunsRequest({ projectId, limit: 1000 })),
      ]);
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      const specs = new Map((response.project?.spec?.agents || []).map((agent) => [agent.name, agent.scheduler]));
      const summaries = (response.project?.schedulers || []).filter((summary) => !!specs.get(summary.agentName));
      const details = await Promise.all(summaries.map((summary) => projectService.getScheduler(new GetSchedulerRequest({ project: { projectId }, agentName: summary.agentName })).catch(() => undefined)));
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      rows = summaries.map((summary, index) => {
        const triggers = specs.get(summary.agentName)?.triggers || [];
        const resolvedTriggers = Object.fromEntries((details[index]?.triggers || []).filter((trigger) => trigger.spec?.name).map((trigger) => [trigger.spec!.name, trigger]));
        return { sourceProjectId: projectId, summary, triggers, resolvedTriggers, events: [], eventsCursor: '', seenEventCursors: [], eventsLoading: false };
      });
      sandboxIds = [...new Set((runResponse.runs || []).map((run) => run.sandboxId).filter(Boolean))];
      for (const row of rows) void loadEvents(row, generation);
    } catch (cause: any) {
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      rows = [];
      error = cause?.message || '加载 Scheduler 定义失败';
      store.addToast(error, 'error');
    }
    finally { if (generation === loadGeneration && projectId === store.activeProjectId) loading = false; }
  }

  $effect(() => { void store.runtimeRefreshVersion; void load(); });

  async function loadEvents(row: SchedulerRow, generation: number, append = false) {
    const projectId = row.sourceProjectId;
    const cursor = append ? row.eventsCursor : '';
    if (append && (!cursor || row.eventsLoading || row.seenEventCursors.includes(cursor))) return;
    if (append) rows = rows.map((current) => current.summary.schedulerId === row.summary.schedulerId ? { ...current, eventsLoading: true } : current);
    try {
      const response = await projectService.listSchedulerEvents(new ListSchedulerEventsRequest({ project: { projectId }, agentName: row.summary.agentName, limit: 100, cursor }));
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      rows = rows.map((current) => {
        if (current.summary.schedulerId !== row.summary.schedulerId) return current;
        const seenEventCursors = cursor ? [...current.seenEventCursors, cursor] : current.seenEventCursors;
        const nextCursor = response.nextCursor && !seenEventCursors.includes(response.nextCursor) ? response.nextCursor : '';
        return { ...current, events: append ? [...current.events, ...response.events] : response.events, eventsCursor: nextCursor, seenEventCursors, eventsLoading: false };
      });
    } catch (cause: any) {
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      rows = rows.map((current) => current.summary.schedulerId === row.summary.schedulerId ? { ...current, eventsLoading: false } : current);
      error = cause?.message || '加载 Scheduler 事件失败';
      store.addToast(error, 'error');
    }
  }

  async function setSchedulerEnabled(row: SchedulerRow) {
    const projectId = row.sourceProjectId;
    if (!projectId || projectId !== store.activeProjectId) return;
    const generation = loadGeneration;
    const key = `scheduler/${row.summary.schedulerId}`;
    controlling = key;
    error = '';
    try {
      const response = await projectService.setSchedulerEnabled(new SetSchedulerEnabledRequest({ project: { projectId }, agentName: row.summary.agentName, enabled: !row.summary.enabled }));
      if (generation !== loadGeneration || projectId !== store.activeProjectId || !response.scheduler) return;
      rows = rows.map((current) => current.summary.schedulerId === row.summary.schedulerId ? { ...current, summary: response.scheduler! } : current);
    } catch (cause: any) {
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      error = cause?.message || '更新 Scheduler 状态失败';
      store.addToast(error, 'error');
    } finally {
      if (generation === loadGeneration && projectId === store.activeProjectId) controlling = '';
    }
  }

  async function setTriggerEnabled(row: SchedulerRow, trigger: TriggerSpec) {
    const projectId = row.sourceProjectId;
    if (!projectId || projectId !== store.activeProjectId) return;
    const generation = loadGeneration;
    const resolved = row.resolvedTriggers[trigger.name];
    if (!resolved?.triggerId) return;
    const key = `trigger/${row.summary.schedulerId}/${trigger.name}`;
    controlling = key;
    error = '';
    try {
      const response = await projectService.setSchedulerTriggerEnabled(new SetSchedulerTriggerEnabledRequest({ project: { projectId }, agentName: row.summary.agentName, triggerId: resolved.triggerId, enabled: !resolved.enabled }));
      if (generation !== loadGeneration || projectId !== store.activeProjectId || !response.trigger) return;
      rows = rows.map((current) => current.summary.schedulerId === row.summary.schedulerId
        ? { ...current, resolvedTriggers: { ...current.resolvedTriggers, [trigger.name]: response.trigger! } }
        : current);
    } catch (cause: any) {
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      error = cause?.message || '更新 Trigger 状态失败';
      store.addToast(error, 'error');
    } finally {
      if (generation === loadGeneration && projectId === store.activeProjectId) controlling = '';
    }
  }

  function formatTimestamp(event: SchedulerEvent) {
    return event.createdAt?.toDate().toLocaleString() || '-';
  }

  async function run(row: SchedulerRow, trigger: TriggerSpec) {
    const projectId = row.sourceProjectId;
    if (!projectId || projectId !== store.activeProjectId) return;
    const generation = loadGeneration;
    const key = `${projectId}/${row.summary.schedulerId}/${trigger.name}`;
    running = key;
    error = '';
    try {
      const payloadJson = (payloads[key] || '').trim();
      const advanced = overrides[key];
      if (payloadJson) JSON.parse(payloadJson);
      if (!advanced?.sandboxId) {
        const sourcePath = store.projects?.find((project) => project.summary.projectId === projectId)?.summary.sourcePath || '';
        await assertManagedWorkspace({ yaml: store.editorContent, sourcePath });
      }
      const request = new RunAgentRequest({
        projectId, agentName: row.summary.agentName,
        source: RunSource.MANUAL, prompt: advanced?.prompt.trim() || trigger.prompt,
        schedulerId: row.summary.schedulerId, triggerId: row.resolvedTriggers[trigger.name]?.triggerId || trigger.name, payloadJson,
        sandboxId: advanced?.sandboxId || '', driver: advanced?.driver.trim() || '',
        cleanupPolicy: advanced?.cleanupPolicy || RunSandboxCleanupPolicy.UNSPECIFIED,
        jupyter: advanced?.jupyterEnabled ? new RunJupyterSpec({ enabled: true, expose: advanced.jupyterExpose }) : undefined,
      });
      const detached = advanced?.executionMode === 'detached';
      let runId = '';
      if (detached) {
        const response = await runService.startRun(new StartRunRequest({ run: request }));
        runId = response.run?.runId || '';
      } else {
        const response = await runService.runAgent(request);
        runId = response.run?.summary?.runId || '';
      }
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      if (runId) store.navigateTo('run-detail', { agentName: row.summary.agentName, runId });
      else store.addToast('运行完成，但后端未返回 Run ID', 'error');
    } catch (cause: any) {
      if (generation !== loadGeneration || projectId !== store.activeProjectId) return;
      error = cause instanceof SyntaxError ? 'Payload JSON 格式无效' : (cause?.message || '手动运行失败');
      store.addToast(error, 'error');
    }
    finally { if (generation === loadGeneration && projectId === store.activeProjectId) running = ''; }
  }

  function ensureOverrides(key: string, trigger: TriggerSpec) {
    overrides[key] ||= { executionMode: 'wait', sandboxId: '', driver: '', prompt: trigger.prompt, cleanupPolicy: RunSandboxCleanupPolicy.UNSPECIFIED, jupyterEnabled: false, jupyterExpose: false };
    return overrides[key];
  }
</script>

<div class="root">
  <div class="breadcrumb-wrap"><RuntimeBreadcrumb eyebrow="来源：v2 Scheduler API" title="Scheduler 定义" onBack={() => store.navigateBack()} actions={[{ label: '刷新', onclick: load, variant: 'primary' }]} /></div>
  {#if loading}<div class="state">加载中...</div>
  {:else if rows.length === 0}<div class="state">当前项目没有 Scheduler 定义</div>
  {:else}<div class="list">{#each rows as row (row.summary.schedulerId)}<article>
    <div class="summary"><strong>{row.summary.agentName}</strong><code>{row.summary.schedulerId}</code><button aria-label={`${row.summary.enabled ? '禁用' : '启用'} Scheduler ${row.summary.agentName}`} onclick={() => setSchedulerEnabled(row)} disabled={!!controlling}>{controlling === `scheduler/${row.summary.schedulerId}` ? '保存中...' : (row.summary.enabled ? '已启用' : '已停用')}</button></div>
    {#if row.triggers.length === 0}<p>未读取到 Trigger 定义</p>{/if}
    {#each row.triggers as trigger (trigger.name)}{@const key = `${row.sourceProjectId}/${row.summary.schedulerId}/${trigger.name}`} {@const resolved = row.resolvedTriggers[trigger.name]}
      <div class="trigger"><div><strong>{trigger.name}</strong><span>{trigger.kind} {trigger.cron || trigger.interval}</span></div>
        <input aria-label={`${trigger.name} Payload JSON`} bind:value={payloads[key]} placeholder="Payload JSON（可选）"/>
        <button aria-label={resolved ? `${resolved.enabled ? '禁用' : '启用'} Trigger ${trigger.name}` : `Trigger ${trigger.name} 状态未知`} onclick={() => setTriggerEnabled(row, trigger)} disabled={!!controlling || !resolved}>{controlling === `trigger/${row.summary.schedulerId}/${trigger.name}` ? '保存中...' : (resolved ? (resolved.enabled ? '已启用' : '已停用') : '状态未知')}</button>
        <button aria-label={`手动运行 ${trigger.name}`} onclick={() => run(row, trigger)} disabled={!!running}>{running === key ? '运行中...' : '手动 Run'}</button>
      </div>
      <details class="advanced" ontoggle={(event) => { if (event.currentTarget.open) ensureOverrides(key, trigger); }}>
        <summary aria-label={`${trigger.name} 一次性 Run 高级选项`}>一次性 Run 高级选项</summary>
        <p>仅覆盖本次 Run，不修改 YAML。</p>
        {#if overrides[key]}<div class="advanced-grid">
          <label>执行方式<select aria-label={`${trigger.name} 执行方式`} value={overrides[key].executionMode} onchange={(event) => overrides[key].executionMode = event.currentTarget.value as 'wait' | 'detached'}><option value="wait">流式等待</option><option value="detached">后台启动（detached）</option></select></label>
          <label>Sandbox<select aria-label={`${trigger.name} Sandbox`} value={overrides[key].sandboxId} onchange={(event) => overrides[key].sandboxId = event.currentTarget.value}><option value="">新建 / 后端默认</option>{#each sandboxIds as id}<option value={id}>{id}</option>{/each}</select></label>
          <label>Driver<input aria-label={`${trigger.name} Driver`} bind:value={overrides[key].driver} placeholder="后端默认" /></label>
          <label class="wide">Prompt<textarea aria-label={`${trigger.name} Prompt`} bind:value={overrides[key].prompt}></textarea></label>
          <label>Cleanup policy<select aria-label={`${trigger.name} Cleanup policy`} value={overrides[key].cleanupPolicy} onchange={(event) => overrides[key].cleanupPolicy = Number(event.currentTarget.value)}><option value={RunSandboxCleanupPolicy.UNSPECIFIED}>后端默认</option><option value={RunSandboxCleanupPolicy.STOP_ON_COMPLETION}>完成后停止</option><option value={RunSandboxCleanupPolicy.KEEP_RUNNING}>保持运行</option><option value={RunSandboxCleanupPolicy.REMOVE_ON_COMPLETION}>完成后删除</option></select></label>
          <label><input type="checkbox" aria-label={`${trigger.name} Jupyter enabled`} bind:checked={overrides[key].jupyterEnabled} /> Jupyter enabled</label>
          <label><input type="checkbox" aria-label={`${trigger.name} Jupyter expose`} bind:checked={overrides[key].jupyterExpose} disabled={!overrides[key].jupyterEnabled} /> Jupyter expose</label>
        </div>{/if}
      </details>
    {/each}
    <section class="events" aria-label={`${row.summary.agentName} Scheduler 事件`}><h3>事件历史</h3>
      {#if row.events.length === 0}<p>暂无事件</p>{:else}{#each row.events as event (event.id)}<div class="event"><time>{formatTimestamp(event)}</time><strong>{event.type || 'event'} · {event.level || '-'}</strong><span>{event.message || '-'}</span></div>{/each}{/if}
      {#if row.eventsCursor}<button aria-label={`加载更多 ${row.summary.agentName} Scheduler 事件`} onclick={() => loadEvents(row, loadGeneration, true)} disabled={row.eventsLoading}>{row.eventsLoading ? '加载中...' : '加载更多'}</button>{/if}
    </section>
  </article>{/each}</div>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>.root{height:100%;overflow:auto;padding:0 14px 14px}.breadcrumb-wrap{margin:0 -14px 12px}button,input,select,textarea{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);padding:6px 8px}.state{padding:30px;text-align:center;color:var(--text-muted)}.list{display:grid;gap:8px;margin-bottom:12px}article{padding:10px;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-secondary)}.summary{display:grid;grid-template-columns:120px 1fr 100px;gap:8px}.summary code,.trigger span{color:var(--text-muted);font-size:var(--font-size-xs)}.trigger{display:grid;grid-template-columns:180px 1fr auto auto;gap:8px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--border-color)}.trigger div{display:flex;flex-direction:column}.trigger input{background:var(--bg-primary)}.advanced{margin:8px 0 0 180px}.advanced summary{cursor:pointer}.advanced p,.events p{color:var(--text-muted);font-size:var(--font-size-sm)}.advanced-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.advanced-grid label{display:flex;flex-direction:column;gap:4px;font-size:var(--font-size-sm)}.advanced-grid label:has(input[type=checkbox]){flex-direction:row;align-items:center}.advanced-grid .wide{grid-column:1/-1}.advanced-grid textarea{min-height:54px;resize:vertical}.events{margin-top:12px;border-top:1px solid var(--border-color)}.events h3{font-size:var(--font-size-md)}.event{display:grid;grid-template-columns:160px 150px 1fr;gap:8px;padding:5px 0;font-size:var(--font-size-sm)}.event time{color:var(--text-muted)}</style>
