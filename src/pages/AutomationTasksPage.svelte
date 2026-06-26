<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import ExperimentOutlined from '@ant-design/icons-svg/es/asn/ExperimentOutlined';
  import FilterOutlined from '@ant-design/icons-svg/es/asn/FilterOutlined';

  import AntIcon from '../components/AntIcon.svelte';
  import {
    deleteAutomationTask,
    getAutomationTask,
    listAutomationTasks,
    runAutomationTaskNow,
    saveAutomationTask,
    setAutomationTaskEnabled,
    setAutomationTriggerEnabled,
    validateAutomationTask,
    type AutomationTaskDetail,
    type AutomationTrigger,
    type AutomationTask,
  } from '../api/loaders';
  import { listAgentDefinitions, type AgentDefinition } from '../api/agents';
  import { listCapabilitySets, type CapabilitySet } from '../api/config';
  import { formatBeijingTime } from '../time';
  import { appPath } from '../paths';
  import { currentQueryParams, updateQueryParams } from '../url';

  type EnvItem = { name: string; value: string; secret: boolean };

  type DraftTask = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    configMode: 'form' | 'code';
    agentId: string;
    capsetIds: string[];
    defaultAgent: string;
    triggerType: 'cron' | 'interval' | 'event' | 'timeout';
    triggerName: string;
    taskInput: string;
    guestImage: string;
    concurrencyPolicy: 'skip_if_running' | 'parallel';
    sessionPolicy: 'reuse_session' | 'new_session';
    loaderScript: string;
    envItems: EnvItem[];
    codeValidationStatus: 'unvalidated' | 'passed' | 'failed';
  };

  let loading = true;
  let error = '';
  let tasks: AutomationTask[] = [];
  let agents: AgentDefinition[] = [];
  let capsets: CapabilitySet[] = [];
  let keyword = '';
  let triggerFilter = '';
  let drawerOpen = false;
  let debugTask: AutomationTask | null = null;
  let draft: DraftTask = emptyDraft();
  let debugPayload = '{}';
  let saving = false;
  let validating = false;
  let draftLoading = false;
  let runningTaskId = '';
  let actionMessage = '';
  let actionMessageTimer: ReturnType<typeof setTimeout> | null = null;
  let draftTriggers: AutomationTrigger[] = [];
  let codeScrollTop = 0;
  let codeScrollLeft = 0;

  // Detail-pane state for the master/detail layout. Selected task id is
  // mirrored to the URL (?task=...) so navigating preserves the selection.
  let selectedTaskId = '';
  let detailById: Record<string, AutomationTaskDetail> = {};
  let detailLoadingId = '';
  let detailError = '';
  let scriptExpanded = false;
  let toggleBusyId = '';
  let triggerBusyId = '';
  let deleteConfirmId = '';

  $: activeAgents = agents.filter((agent) => !agent.deletedAt && agent.enabled);
  $: agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  $: selectedDraftAgent = agentsById.get(draft.agentId) ?? null;
  $: filteredTasks = tasks.filter((task) =>
    [task.name, task.description, task.defaultAgent, agentLabel(task.agentId), task.id].join(' ').toLowerCase().includes(keyword.toLowerCase()) &&
    (!triggerFilter || task.runtime === triggerFilter),
  );
  // Resolve the active task without coupling back into selectedTaskId — the
  // explicit fallback to filteredTasks[0] keeps the detail pane non-empty
  // while the URL still drives selection. Mirror the AgentsPage pattern.
  $: activeTask = (selectedTaskId && filteredTasks.find((task) => task.id === selectedTaskId)) || filteredTasks[0] || null;
  $: activeDetail = activeTask ? detailById[activeTask.id] || null : null;
  $: if (activeTask) {
    void ensureDetail(activeTask.id);
  }

  onMount(() => {
    void load();
    window.addEventListener('popstate', syncFromURL);
    return () => window.removeEventListener('popstate', syncFromURL);
  });

  onDestroy(() => {
    if (actionMessageTimer) {
      clearTimeout(actionMessageTimer);
    }
  });

  function showMessage(text: string): void {
    actionMessage = text;
    if (actionMessageTimer) {
      clearTimeout(actionMessageTimer);
    }
    actionMessageTimer = setTimeout(() => {
      actionMessage = '';
      actionMessageTimer = null;
    }, 3000);
  }

  function syncFromURL(): void {
    const params = currentQueryParams();
    const taskId = params.get('task') || '';
    if (taskId && tasks.some((task) => task.id === taskId)) {
      selectedTaskId = taskId;
    } else if (!selectedTaskId && filteredTasks.length > 0) {
      selectedTaskId = filteredTasks[0].id;
    }
  }

  function selectTask(task: AutomationTask): void {
    selectedTaskId = task.id;
    scriptExpanded = false;
    deleteConfirmId = '';
    detailError = '';
    updateQueryParams({ task: task.id });
  }

  async function ensureDetail(taskId: string): Promise<void> {
    if (!taskId || detailById[taskId] || detailLoadingId === taskId) return;
    detailLoadingId = taskId;
    detailError = '';
    try {
      const detail = await getAutomationTask(taskId);
      detailById = { ...detailById, [taskId]: detail };
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    } finally {
      if (detailLoadingId === taskId) detailLoadingId = '';
    }
  }

  async function reloadDetail(taskId: string): Promise<void> {
    if (!taskId) return;
    try {
      const detail = await getAutomationTask(taskId);
      detailById = { ...detailById, [taskId]: detail };
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    }
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      [tasks, agents] = await Promise.all([
        listAutomationTasks(),
        listAgentDefinitions(),
      ]);
      // Capability sets are optional: a missing/unreachable gateway must not
      // block the task list.
      try {
        capsets = await listCapabilitySets();
      } catch {
        capsets = [];
      }
      // Drop cached details for tasks that no longer exist after a refresh.
      const liveIds = new Set(tasks.map((task) => task.id));
      detailById = Object.fromEntries(Object.entries(detailById).filter(([id]) => liveIds.has(id)));
      syncFromURL();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function clearTaskFilters(): void {
    keyword = '';
    triggerFilter = '';
  }

  function emptyDraft(): DraftTask {
    return {
      id: '',
      name: '',
      description: '',
      enabled: false,
      configMode: 'code',
      agentId: '',
      capsetIds: [],
      defaultAgent: '',
      triggerType: 'cron',
      triggerName: '',
      taskInput: '',
      guestImage: '',
      concurrencyPolicy: 'skip_if_running',
      sessionPolicy: 'new_session',
      loaderScript: defaultCodeTemplate(),
      envItems: [],
      codeValidationStatus: 'unvalidated',
    };
  }

  function defaultCodeTemplate(): string {
    return `function main(payload) {
  scheduler.log("manual run", { payload });
  return { ok: true, payload: payload ?? null };
}

scheduler.interval("heartbeat", function heartbeat() {
  scheduler.log("heartbeat", { at: new Date().toISOString() });
}, 60000);
`;
  }

  function openCreate(): void {
    draft = emptyDraft();
    // New tasks default to every available capset selected.
    draft.capsetIds = capsets.map((capset) => capset.id);
    draftTriggers = [];
    drawerOpen = true;
  }

  function toggleTaskCapset(id: string, checked: boolean): void {
    const ids = checked ? [...draft.capsetIds, id] : draft.capsetIds.filter((value) => value !== id);
    draft = { ...draft, capsetIds: ids };
  }

  async function openEdit(task: AutomationTask): Promise<void> {
    draft = {
      id: task.id,
      name: task.name,
      description: task.description,
      enabled: task.enabled,
      configMode: 'code',
      agentId: task.agentId,
      capsetIds: task.capsetIds,
      defaultAgent: task.defaultAgent,
      triggerType: triggerTypeFromRuntime(task.runtime),
      triggerName: task.triggerCount > 0 ? '默认触发规则' : '',
      taskInput: '',
      guestImage: task.guestImage,
      concurrencyPolicy: task.concurrencyPolicy === 'parallel' ? 'parallel' : 'skip_if_running',
      sessionPolicy: task.sessionPolicy === 'reuse_session' ? 'reuse_session' : 'new_session',
      loaderScript: defaultCodeTemplate(),
      envItems: [],
      codeValidationStatus: 'unvalidated',
    };
    drawerOpen = true;
    draftTriggers = [];
    draftLoading = true;
    error = '';
    try {
      const detail = await getAutomationTask(task.id);
      draftTriggers = detail.triggers;
      draft = {
        ...draft,
        id: detail.id,
        name: detail.name,
        description: detail.description,
        enabled: detail.enabled,
        configMode: 'code',
        loaderScript: detail.script || defaultCodeTemplate(),
        agentId: detail.agentId,
        capsetIds: detail.capsetIds,
        defaultAgent: detail.defaultAgent,
        guestImage: detail.guestImage,
        concurrencyPolicy: detail.concurrencyPolicy === 'parallel' ? 'parallel' : 'skip_if_running',
        sessionPolicy: detail.sessionPolicy === 'reuse_session' ? 'reuse_session' : 'new_session',
        envItems: detail.envItems.map((item) => ({ ...item })),
        codeValidationStatus: 'passed',
      };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      draftLoading = false;
    }
  }

  async function validateDraft(): Promise<void> {
    if (draftLoading) return;
    validating = true;
    error = '';
    try {
      const result = await validateAutomationTask(scriptForDraft(draft), 'scheduler');
      draftTriggers = result.triggers;
      draft.codeValidationStatus = 'passed';
      showMessage('校验通过');
    } catch (err) {
      draft.codeValidationStatus = 'failed';
      error = err instanceof Error ? err.message : String(err);
    } finally {
      validating = false;
    }
  }

  async function saveDraft(debug = false): Promise<void> {
    if (draftLoading) return;
    if (!draft.name.trim()) {
      error = '任务名称必填';
      return;
    }
    const selectedAgent = agentsById.get(draft.agentId);
    if (!selectedAgent || selectedAgent.deletedAt) {
      error = '请选择可用智能体';
      return;
    }
    saving = true;
    error = '';
    try {
      const script = scriptForDraft(draft);
      const validation = await validateAutomationTask(script, 'scheduler');
      draftTriggers = validation.triggers;
      draft.codeValidationStatus = 'passed';
      const task = await saveAutomationTask({
        id: draft.id || undefined,
        name: draft.name,
        description: draft.description,
        runtime: 'scheduler',
        script,
        workspaceId: selectedAgent.workspaceId,
        driver: selectedAgent.driver,
        guestImage: draft.guestImage || selectedAgent.guestImage,
        agentId: selectedAgent.id,
        capsetIds: draft.capsetIds,
        defaultAgent: selectedAgent.provider,
        sessionPolicy: draft.sessionPolicy,
        concurrencyPolicy: draft.concurrencyPolicy,
        enabled: draft.enabled && draft.codeValidationStatus !== 'failed',
        envItems: draft.envItems,
      });
      tasks = [task, ...tasks.filter((item) => item.id !== task.id)];
      // saveAutomationTask returns the full detail, including script + triggers
      // + envItems. Cache it so the right pane updates without an extra fetch.
      detailById = { ...detailById, [task.id]: task };
      selectedTaskId = task.id;
      drawerOpen = false;
      showMessage(draft.id ? '自动化任务已更新' : '自动化任务已创建');
      if (debug && draft.codeValidationStatus !== 'failed') {
        debugTask = task;
        debugPayload = payloadForDraft(draft);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  async function toggleTask(task: AutomationTask): Promise<void> {
    error = '';
    toggleBusyId = task.id;
    try {
      const updated = await setAutomationTaskEnabled(task.id, !task.enabled);
      tasks = tasks.map((item) => item.id === task.id ? updated : item);
      const cached = detailById[task.id];
      if (cached) {
        detailById = { ...detailById, [task.id]: { ...cached, ...updated } };
      }
      showMessage(updated.enabled ? '任务已启用' : '任务已暂停');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      toggleBusyId = '';
    }
  }

  async function toggleTrigger(taskId: string, trigger: AutomationTrigger): Promise<void> {
    error = '';
    triggerBusyId = trigger.triggerId;
    try {
      const detail = await setAutomationTriggerEnabled(taskId, trigger.triggerId, !trigger.enabled);
      detailById = { ...detailById, [detail.id]: detail };
      tasks = tasks.map((item) => item.id === detail.id ? detail : item);
      // Keep the edit-drawer view in sync if it's open on this task.
      if (drawerOpen && draft.id === detail.id) {
        draftTriggers = detail.triggers;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      triggerBusyId = '';
    }
  }

  function triggerKindLabel(kind: string): string {
    if (kind.includes('INTERVAL')) return '周期触发';
    if (kind.includes('EVENT')) return '事件触发';
    if (kind.includes('TIMEOUT')) return '延迟触发';
    if (kind.includes('CRON')) return '定时触发';
    return kind || '-';
  }

  async function deleteTask(task: AutomationTask): Promise<void> {
    if (deleteConfirmId !== task.id) {
      deleteConfirmId = task.id;
      return;
    }
    error = '';
    try {
      await deleteAutomationTask(task.id);
      tasks = tasks.filter((item) => item.id !== task.id);
      const next = { ...detailById };
      delete next[task.id];
      detailById = next;
      if (selectedTaskId === task.id) {
        const fallback = tasks[0]?.id || '';
        selectedTaskId = fallback;
        updateQueryParams({ task: fallback || null });
      }
      deleteConfirmId = '';
      showMessage('自动化任务已删除');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function runDebugTask(): Promise<void> {
    if (!debugTask) return;
    error = '';
    try {
      JSON.parse(debugPayload || '{}');
    } catch {
      error = '模拟触发上下文必须是合法 JSON';
      return;
    }
    try {
      const run = await runAutomationTaskNow(debugTask.id, debugPayload || '{}');
      const taskUrl = runCenterTaskUrl(debugTask.agentId, debugTask.id, run.id);
      closeDebugDrawer();
      window.location.assign(taskUrl);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function runTaskNow(task: AutomationTask): Promise<void> {
    runningTaskId = task.id;
    error = '';
    try {
      const detail = detailById[task.id] || await getAutomationTask(task.id);
      detailById = { ...detailById, [detail.id]: detail };
      const run = await runAutomationTaskNow(task.id, payloadForTask(detail));
      window.location.assign(runCenterTaskUrl(task.agentId, task.id, run.id));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      runningTaskId = '';
    }
  }

  function closeDrawer(): void {
    drawerOpen = false;
  }

  function closeDrawerFromKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      closeDrawer();
    }
  }

  function closeDebugDrawer(): void {
    debugTask = null;
    debugPayload = '{}';
  }

  function closeDebugDrawerFromKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      closeDebugDrawer();
    }
  }

  function triggerTypeFromRuntime(runtime: string): DraftTask['triggerType'] {
    if (runtime === 'interval' || runtime === 'event' || runtime === 'timeout' || runtime === 'cron') {
      return runtime;
    }
    return 'cron';
  }

  // Build a Run Center URL pointing into the agent's "任务执行" (tasks) sub-mode,
  // pre-selecting the task and just-started run so the user lands where the
  // execution is observable instead of the default chat view.
  function runCenterTaskUrl(agentId: string, taskId: string, runId: string): string {
    const params = new URLSearchParams();
    params.set('type', 'automation_run');
    params.set('mode', 'tasks');
    if (agentId) params.set('agentId', agentId);
    if (taskId) params.set('taskId', taskId);
    if (runId) params.set('runId', runId);
    return appPath(`/runs?${params.toString()}`);
  }

  function scriptForDraft(item: DraftTask): string {
    if (item.configMode === 'code') {
      return item.loaderScript;
    }
    return formScript(item);
  }

  function payloadForDraft(item: DraftTask): string {
    const provider = providerForDraft(item);
    return JSON.stringify({
      taskInput: item.taskInput,
      triggerName: item.triggerName || 'manual',
      agent: provider,
    }, null, 2);
  }

  function payloadForTask(task: AutomationTask): string {
    return JSON.stringify({
      taskInput: task.description || task.name,
      triggerName: 'manual',
      agent: task.defaultAgent || 'codex',
    }, null, 2);
  }

  function formScript(item: DraftTask): string {
    const taskInput = JSON.stringify(item.taskInput || '');
    const triggerName = JSON.stringify(item.triggerName || 'default');
    const agent = JSON.stringify(providerForDraft(item));
    const handlerName = safeIdentifier(item.triggerName || item.triggerType || 'default');
    const body = `function main(payload) {
  const taskInput = payload && payload.taskInput ? payload.taskInput : ${taskInput};
  scheduler.log("automation task started", { taskInput, agent: ${agent} });
  return { ok: true, taskInput, agent: ${agent}, payload: payload ?? null };
}
`;
    if (item.triggerType === 'interval') {
      return `${body}
scheduler.interval(${triggerName}, function ${handlerName}(payload) {
  return main(payload);
}, 60000);
`;
    }
    if (item.triggerType === 'timeout') {
      return `${body}
scheduler.timeout(${triggerName}, function ${handlerName}(payload) {
  return main(payload);
}, 60000);
`;
    }
    if (item.triggerType === 'event') {
      return `${body}
scheduler.on("agent-compose.*", ${triggerName}, function ${handlerName}(event) {
  return main(event);
});
`;
    }
    return `${body}
scheduler.cron(${triggerName}, "0 8 * * *", function ${handlerName}(payload) {
  return main(payload);
});
`;
  }

  function triggerSummary(task: AutomationTask): string {
    if (task.triggerCount <= 0) return '未配置';
    if (task.triggerCount === 1) return '1 条规则';
    return `${task.triggerCount} 条规则`;
  }

  function safeIdentifier(value: string): string {
    const normalized = value.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^[^A-Za-z_$]+/, '');
    return normalized || 'handler';
  }

  function providerForDraft(item: DraftTask): string {
    return agentsById.get(item.agentId)?.provider || item.defaultAgent || 'codex';
  }

  function agentLabel(agentId: string): string {
    const agent = agentsById.get(agentId);
    if (!agent) return agentId || '未绑定智能体';
    return agent.deletedAt ? `${agent.name}（已删除）` : agent.name;
  }

  function selectDraftAgent(agentId: string): void {
    const agent = agentsById.get(agentId);
    draft.agentId = agentId;
    if (!agent) {
      draft.defaultAgent = '';
      return;
    }
    draft.defaultAgent = agent.provider;
    if (!draft.guestImage && agent.guestImage) {
      draft.guestImage = agent.guestImage;
    }
  }

  function addEnvItem(): void {
    draft.envItems = [...draft.envItems, { name: '', value: '', secret: false }];
  }

  function removeEnvItem(index: number): void {
    draft.envItems = draft.envItems.filter((_, itemIndex) => itemIndex !== index);
  }

  function syncCodeScroll(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    codeScrollTop = target.scrollTop;
    codeScrollLeft = target.scrollLeft;
  }

  function highlightedJavaScript(source: string): string {
    const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|from|async|await|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
    return escapeHTML(source).replace(pattern, (token) => {
      const className = javascriptTokenClass(token);
      return className ? `<span class="${className}">${token}</span>` : token;
    });
  }

  function javascriptTokenClass(token: string): string {
    if (token.startsWith('//') || token.startsWith('/*')) return 'tok-comment';
    if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return 'tok-string';
    if (/^\d/.test(token)) return 'tok-number';
    if (/^(const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|from|async|await|true|false|null|undefined)$/.test(token)) return 'tok-keyword';
    return 'tok-function';
  }

  function escapeHTML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function statusLabel(task: AutomationTask): string {
    if (task.lastError) return '错误';
    return task.enabled ? '已启用' : '已暂停';
  }

  function statusClass(task: AutomationTask): 'green' | 'amber' | 'red' {
    if (task.lastError) return 'red';
    return task.enabled ? 'green' : 'amber';
  }

  function runtimeLabel(task: AutomationTask): string {
    return task.runtime || 'scheduler';
  }

  function triggerSpec(trigger: AutomationTrigger): string {
    if (trigger.kind.includes('CRON')) return trigger.specJson || '-';
    if (trigger.kind.includes('INTERVAL')) {
      return trigger.intervalMs ? `每 ${Math.round(trigger.intervalMs / 1000)}s` : (trigger.specJson || '-');
    }
    if (trigger.kind.includes('EVENT')) return trigger.topic || trigger.specJson || '-';
    if (trigger.kind.includes('TIMEOUT')) {
      return trigger.intervalMs ? `延迟 ${Math.round(trigger.intervalMs / 1000)}s` : (trigger.specJson || '-');
    }
    return trigger.specJson || trigger.topic || '-';
  }

  function formatDateTime(value: string): string {
    return formatBeijingTime(value);
  }

  function detailScript(detail: AutomationTaskDetail | null): string {
    return detail?.script || '';
  }

  function previewScript(source: string, limit = 14): string {
    if (!source) return '';
    const lines = source.split('\n');
    if (lines.length <= limit) return source;
    return lines.slice(0, limit).join('\n');
  }

  function isScriptTruncated(source: string, limit = 14): boolean {
    return source.split('\n').length > limit;
  }
</script>

{#if error}
  <div class="alert danger">{error}</div>
{/if}
{#if actionMessage}
  <div class="alert success">{actionMessage}</div>
{/if}

<section class="panel agents-panel">
  <div class="runs-toolbar agent-runs-toolbar">
    <div class="run-command-metrics compact">
      <button><span>全部</span><b>{tasks.length}</b></button>
      <button><span>启用</span><b>{tasks.filter((task) => task.enabled).length}</b></button>
      <button><span>暂停</span><b>{tasks.filter((task) => !task.enabled).length}</b></button>
      <button><span>触发规则</span><b>{tasks.reduce((total, task) => total + task.triggerCount, 0)}</b></button>
    </div>
    <div class="runs-filters agent-run-filters">
      <input class="filter-keyword" placeholder="按任务名称、描述、智能体、触发规则筛选" bind:value={keyword}>
      <select bind:value={triggerFilter}><option value="">触发类型</option><option value="cron">定时触发</option><option value="interval">周期触发</option><option value="event">事件触发</option><option value="timeout">延迟触发</option></select>
      <button on:click={load}>{loading ? '刷新中...' : '刷新'}</button>
      <button class="primary" on:click={openCreate}>创建自动化任务</button>
    </div>
  </div>

  {#if loading && tasks.length === 0}
    <div class="empty">加载中...</div>
  {:else if filteredTasks.length === 0}
    <div class="empty-state">
      <div class="empty-state-icon">
        <AntIcon definition={tasks.length === 0 ? ExperimentOutlined : FilterOutlined} />
      </div>
      {#if tasks.length === 0}
        <h3>还没有自动化任务</h3>
        <p>自动化任务通过触发规则（定时 / 周期 / 事件）自动运行智能体。创建第一个任务后即可在这里管理。</p>
        <div class="empty-state-actions">
          <button class="primary" on:click={openCreate}>创建自动化任务</button>
        </div>
      {:else}
        <h3>没有匹配的自动化任务</h3>
        <p>当前共有 {tasks.length} 个任务，但都不满足筛选条件。试试调整或清除筛选。</p>
        <div class="empty-state-actions">
          <button on:click={clearTaskFilters}>清除筛选</button>
        </div>
      {/if}
    </div>
  {:else}
    <div class="agents-master-detail">
      <div class="agent-list-card">
        <div class="run-list-head">
          <b>自动化任务</b>
          <span>{filteredTasks.length} 个</span>
        </div>
        <div class="agent-list">
          {#each filteredTasks as task}
            <button class="agent-list-item" class:active={activeTask?.id === task.id} on:click={() => selectTask(task)}>
              <span>
                <b>{task.name || task.id}</b>
                <small>{agentLabel(task.agentId)} · {triggerSummary(task)}</small>
              </span>
              <em class={statusClass(task)}>{statusLabel(task)}</em>
            </button>
          {/each}
        </div>
      </div>
      <div class="agent-detail-panel">
        {#if activeTask}
          {@const detail = activeDetail}
          {@const linkedAgent = agentsById.get(activeTask.agentId)}
          <div class="agent-detail-head">
            <div>
              <h2>{activeTask.name || activeTask.id}</h2>
              <p>{activeTask.description || '暂无描述'}</p>
            </div>
            <div class="toolbar">
              <span class="chip {statusClass(activeTask)}">{statusLabel(activeTask)}</span>
              <button disabled={toggleBusyId === activeTask.id} on:click={() => toggleTask(activeTask)}>{activeTask.enabled ? '暂停' : '启用'}</button>
              <button disabled={Boolean(activeTask.lastError)} on:click={() => { debugTask = activeTask; debugPayload = '{}'; }}>调试</button>
              <button on:click={() => openEdit(activeTask)}>编辑</button>
              <button class="primary" disabled={runningTaskId === activeTask.id} on:click={() => runTaskNow(activeTask)}>{runningTaskId === activeTask.id ? '运行中...' : '立即运行'}</button>
              <button class="danger-button" class:confirming={deleteConfirmId === activeTask.id} on:click={() => deleteTask(activeTask)}>{deleteConfirmId === activeTask.id ? '确认删除' : '删除'}</button>
            </div>
          </div>

          {#if detailError}
            <div class="alert danger">{detailError}</div>
          {/if}

          <div class="agent-detail-grid">
            <section>
              <h3>基础信息</h3>
              <div class="side-facts">
                <div><span>ID</span><b>{activeTask.id || '-'}</b></div>
                <div><span>运行时</span><b>{runtimeLabel(activeTask)}</b></div>
                <div><span>触发规则</span><b>{activeTask.triggerCount} 条</b></div>
                <div><span>并发策略</span><b>{activeTask.concurrencyPolicy === 'parallel' ? '允许并行运行' : '已有运行时跳过'}</b></div>
                <div><span>会话策略</span><b>{activeTask.sessionPolicy === 'reuse_session' ? '继续使用同一会话' : '每次新建会话'}</b></div>
                <div><span>创建时间</span><b>{formatDateTime(activeTask.createdAt)}</b></div>
                <div><span>更新时间</span><b>{formatDateTime(activeTask.updatedAt)}</b></div>
                {#if activeTask.lastError}
                  <div><span>最近错误</span><b>{activeTask.lastError}</b></div>
                {/if}
              </div>
            </section>
            <section>
              <h3>关联智能体</h3>
              <div class="side-facts">
                <div><span>智能体</span><b>{agentLabel(activeTask.agentId)}</b></div>
                <div><span>Provider</span><b>{linkedAgent?.provider || activeTask.defaultAgent || '-'}</b></div>
                <div><span>运行驱动</span><b>{linkedAgent?.driver || activeTask.driver || '默认'}</b></div>
                <div><span>Guest 镜像</span><b>{activeTask.guestImage || linkedAgent?.guestImage || '默认'}</b></div>
                <div><span>工作区</span><b>{linkedAgent?.workFiles.workspaceName || linkedAgent?.workspaceId || '默认'}</b></div>
                <div><span>最近运行</span><b>{activeTask.latestRunAt ? formatDateTime(activeTask.latestRunAt) : '-'}</b></div>
                <div><span>累计运行</span><b>{activeTask.runCount}</b></div>
              </div>
            </section>
          </div>

          <section class="agent-prompt-panel">
            <div class="form-section-head">
              <h3>触发规则</h3>
              {#if detailLoadingId === activeTask.id && !detail}
                <span class="form-muted">加载中...</span>
              {/if}
            </div>
            {#if !detail}
              <div class="empty">{detailLoadingId === activeTask.id ? '正在加载触发规则…' : '触发规则未加载'}</div>
            {:else if detail.triggers.length === 0}
              <div class="empty">未配置触发规则</div>
            {:else}
              <div class="config-list">
                {#each detail.triggers as trigger}
                  <div class="config-list-item">
                    <div>
                      <b>{trigger.triggerId || '自动生成触发规则'}</b>
                      <p>{triggerKindLabel(trigger.kind)} · {triggerSpec(trigger)}{trigger.nextFireAt ? ` · 下次 ${formatDateTime(trigger.nextFireAt)}` : ''}</p>
                    </div>
                    <div class="toolbar">
                      <span class="chip {trigger.enabled ? 'green' : 'amber'}">{trigger.enabled ? '已启用' : '已暂停'}</span>
                      <button disabled={triggerBusyId === trigger.triggerId} on:click={() => toggleTrigger(activeTask.id, trigger)}>{trigger.enabled ? '暂停' : '开启'}</button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>

          <div class="agent-detail-grid">
            <section>
              <h3>环境变量</h3>
              <div class="side-facts side-facts-wide">
                {#if !detail}
                  <div><span>变量</span><b>{detailLoadingId === activeTask.id ? '加载中…' : '未加载'}</b></div>
                {:else if detail.envItems.length === 0}
                  <div><span>变量</span><b>未配置</b></div>
                {:else}
                  {#each detail.envItems as item}
                    <div><span>{item.name}</span><b>{item.secret ? '已加密/隐藏' : item.value}</b></div>
                  {/each}
                {/if}
              </div>
            </section>
            <section>
              <h3>能力集</h3>
              <div class="side-facts">
                {#if activeTask.capsetIds.length === 0}
                  <div><span>能力集</span><b>未选择</b></div>
                {:else}
                  {#each activeTask.capsetIds as capsetId}
                    {@const capset = capsets.find((item) => item.id === capsetId)}
                    <div><span>能力集</span><b>{capset?.name || capsetId}</b></div>
                  {/each}
                {/if}
              </div>
            </section>
          </div>

          <section class="agent-prompt-panel">
            <div class="form-section-head">
              <h3>任务脚本</h3>
              {#if detail && isScriptTruncated(detailScript(detail))}
                <button type="button" on:click={() => (scriptExpanded = !scriptExpanded)}>{scriptExpanded ? '折叠' : '展开'}</button>
              {/if}
            </div>
            {#if !detail}
              <div class="empty">{detailLoadingId === activeTask.id ? '正在加载脚本…' : '脚本未加载'}</div>
            {:else if !detailScript(detail)}
              <pre>未配置脚本</pre>
            {:else}
              <pre class="agent-config-preview script-preview" class:collapsed={!scriptExpanded && isScriptTruncated(detailScript(detail))}>{@html highlightedJavaScript(scriptExpanded ? detailScript(detail) : previewScript(detailScript(detail)))}</pre>
              {#if !scriptExpanded && isScriptTruncated(detailScript(detail))}
                <small class="form-muted">已展示前 14 行，点击“展开”查看完整脚本，或点击右上角“编辑”进行修改。</small>
              {/if}
            {/if}
          </section>
        {/if}
      </div>
    </div>
  {/if}
</section>

{#if drawerOpen}
  <div class="drawer-mask" role="button" tabindex="0" aria-label="关闭抽屉" on:click={closeDrawer} on:keydown={closeDrawerFromKey}></div>
  <aside class="drawer wide">
    <div class="drawer-head">
      <h2>{draft.id ? '编辑自动化任务' : '创建自动化任务'}</h2>
      <div class="toolbar">
        <button on:click={() => (drawerOpen = false)}>取消</button>
        <button disabled={draftLoading || validating || saving} on:click={validateDraft}>{validating ? '校验中...' : '校验'}</button>
        <button disabled={draftLoading || saving} on:click={() => saveDraft(false)}>{saving ? '保存中...' : '保存'}</button>
        <button class="primary" disabled={draftLoading || saving || draft.codeValidationStatus === 'failed'} on:click={() => saveDraft(true)}>保存并调试</button>
      </div>
    </div>
    <div class="drawer-body">
      {#if draftLoading}
        <div class="alert">正在加载后端任务配置...</div>
      {/if}
      <form class="drawer-form" on:submit|preventDefault={() => saveDraft(false)}>
        <section class="form-section">
          <h3>基础信息</h3>
          <label class="form-item"><span>任务名称</span><input bind:value={draft.name} required></label>
          <label class="form-item"><span>描述</span><textarea rows="2" bind:value={draft.description}></textarea></label>
          <fieldset class="radio-field">
            <legend>任务状态</legend>
            <div class="radio-group">
              <label><input type="radio" bind:group={draft.enabled} value={true} disabled={draft.codeValidationStatus === 'failed'}>任务已启用</label>
              <label><input type="radio" bind:group={draft.enabled} value={false}>任务已暂停</label>
            </div>
          </fieldset>
        </section>

        <section class="form-section">
          <div class="form-section-head">
            <h3>任务编排</h3>
            <div class="detail-tabs mode-tabs" aria-label="任务编排方式">
              <button type="button" class:active={draft.configMode === 'code'} on:click={() => (draft.configMode = 'code')}>代码编排</button>
              <button type="button" class:active={draft.configMode === 'form'} on:click={() => (draft.configMode = 'form')}>表单配置</button>
            </div>
          </div>
          {#if draft.configMode === 'code'}
            <span class="chip {draft.codeValidationStatus === 'failed' ? 'red' : draft.codeValidationStatus === 'passed' ? 'green' : 'amber'}">{draft.codeValidationStatus === 'failed' ? '校验失败' : draft.codeValidationStatus === 'passed' ? '校验通过' : '未校验'}</span>
            <label class="form-item">
              <div class="code-editor-wrap">
                <pre class="code-highlight" aria-hidden="true" style={`transform: translate(${-codeScrollLeft}px, ${-codeScrollTop}px);`}>{@html highlightedJavaScript(draft.loaderScript)}</pre>
                <textarea
                  class="code-editor"
                  rows="18"
                  spellcheck="false"
                  bind:value={draft.loaderScript}
                  on:input={() => (draft.codeValidationStatus = 'unvalidated')}
                  on:scroll={syncCodeScroll}
                ></textarea>
              </div>
            </label>
          {:else}
            <div class="inline-fields">
              <label>触发类型<select bind:value={draft.triggerType}><option value="cron">定时触发</option><option value="interval">周期触发</option><option value="event">事件触发</option><option value="timeout">延迟触发</option></select></label>
              <label>规则名称<input bind:value={draft.triggerName} placeholder="默认触发规则"></label>
            </div>
            <label class="form-item"><span>任务输入</span><textarea rows="5" bind:value={draft.taskInput} placeholder="任务输入，必填多行文本 / Markdown"></textarea></label>
          {/if}
        </section>

        <section class="form-section">
          <h3>平台配置</h3>
          <label class="form-item">
            <span>关联智能体</span>
            <select bind:value={draft.agentId} on:change={(event) => selectDraftAgent(event.currentTarget.value)} required>
              <option value="">请选择智能体</option>
              {#each activeAgents as agent}
                <option value={agent.id}>{agent.name} · {agent.provider}</option>
              {/each}
              {#if draft.agentId && !activeAgents.some((agent) => agent.id === draft.agentId)}
                <option value={draft.agentId}>{agentLabel(draft.agentId)}</option>
              {/if}
            </select>
          </label>
          {#if draft.agentId}
            <div class="descriptions-small">
              <div><span>Provider</span><b>{providerForDraft(draft)}</b></div>
              <div><span>运行环境</span><b>{selectedDraftAgent?.driver || '默认'}</b></div>
              <div><span>工作区</span><b>{selectedDraftAgent?.workFiles.workspaceName || selectedDraftAgent?.workspaceId || '默认'}</b></div>
              <div><span>Guest 镜像</span><b>{selectedDraftAgent?.guestImage || '默认'}</b></div>
            </div>
          {/if}
          <div class="form-item">
            <span>能力集（可多选）</span>
            {#if capsets.length === 0}
              <p class="form-muted">无可用能力集</p>
            {:else}
              <div class="capset-checks">
                {#each capsets as capset}
                  <label class="capset-check">
                    <input type="checkbox" checked={draft.capsetIds.includes(capset.id)} on:change={(event) => toggleTaskCapset(capset.id, event.currentTarget.checked)}>
                    <span>{capset.name || capset.id}</span>
                  </label>
                {/each}
              </div>
            {/if}
          </div>
          <label class="form-item"><span>Guest 镜像</span><input bind:value={draft.guestImage} placeholder="使用智能体配置"></label>
          <section class="form-section agent-env-section">
            <div class="form-section-head">
              <h3>环境变量</h3>
              <button type="button" on:click={addEnvItem}>添加变量</button>
            </div>
            {#if draft.envItems.length === 0}
              <p class="form-muted">未配置环境变量。</p>
            {:else}
              <div class="agent-env-list">
                {#each draft.envItems as item, index}
                  <div class="agent-env-row">
                    <label class="form-item"><span>名称</span><input bind:value={item.name} placeholder="ENV_NAME"></label>
                    <label class="form-item"><span>值</span><input bind:value={item.value} type={item.secret ? 'password' : 'text'} placeholder="变量值"></label>
                    <label class="form-item checkbox-row"><input type="checkbox" bind:checked={item.secret}><span>敏感</span></label>
                    <button type="button" on:click={() => removeEnvItem(index)}>删除</button>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
          <fieldset class="radio-field">
            <legend>并发策略</legend>
            <div class="radio-group">
              <label><input type="radio" bind:group={draft.concurrencyPolicy} value="skip_if_running">已有运行时跳过新触发</label>
              <label><input type="radio" bind:group={draft.concurrencyPolicy} value="parallel" on:change={() => (draft.sessionPolicy = 'new_session')}>允许并行运行</label>
            </div>
          </fieldset>
          <fieldset class="radio-field">
            <legend>会话策略</legend>
            <div class="radio-group">
              <label><input type="radio" bind:group={draft.sessionPolicy} value="reuse_session" disabled={draft.concurrencyPolicy === 'parallel'}>继续使用同一会话</label>
              <label><input type="radio" bind:group={draft.sessionPolicy} value="new_session">每次执行新建会话</label>
            </div>
          </fieldset>
        </section>

        <section class="form-section">
          <h3>触发规则</h3>
          {#if draftTriggers.length === 0}
            <div class="empty">校验后展示脚本识别出的触发规则。</div>
          {:else}
            <div class="config-list">
              {#each draftTriggers as trigger}
                <div class="config-list-item">
                  <div>
                    <b>{trigger.triggerId || '自动生成触发规则'}</b>
                    <p>{triggerKindLabel(trigger.kind)} · {trigger.topic || trigger.intervalMs || trigger.specJson || '-'}</p>
                  </div>
                  <div class="toolbar">
                    <span class="chip {trigger.enabled ? 'green' : 'amber'}">{trigger.enabled ? '已启用' : '已暂停'}</span>
                    <button disabled={!draft.id} on:click={() => draft.id && toggleTrigger(draft.id, trigger)}>{trigger.enabled ? '暂停' : '开启'}</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

      </form>
    </div>
  </aside>
{/if}

{#if debugTask}
  <div class="drawer-mask" role="button" tabindex="0" aria-label="关闭调试抽屉" on:click={closeDebugDrawer} on:keydown={closeDebugDrawerFromKey}></div>
  <aside class="drawer">
    <div class="drawer-head">
      <h2>自动化任务调试运行</h2>
      <div class="toolbar">
        <button on:click={() => (debugTask = null)}>取消</button>
        <button class="primary" on:click={runDebugTask}>运行</button>
      </div>
    </div>
    <div class="drawer-body">
      <div class="descriptions-small">
        <div><span>任务名称</span><b>{debugTask.name}</b></div>
        <div><span>任务状态</span><b>{debugTask.enabled ? '任务已启用' : '任务已暂停'}，调试运行不受暂停影响</b></div>
      </div>
      <label class="form-item"><span>模拟触发上下文 JSON</span><textarea rows="8" bind:value={debugPayload} placeholder={'{}'}></textarea></label>
    </div>
  </aside>
{/if}

<style>
  .capset-checks {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #fbfdff;
  }
  .capset-check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .capset-check input {
    width: auto;
    margin: 0;
  }

  .script-preview {
    max-height: 320px;
    overflow: auto;
    font-family: var(--mono);
  }
  .script-preview.collapsed {
    max-height: 260px;
    overflow: hidden;
    /* The fade hint at the bottom signals there's more content; the
       "展开" button next to the heading is the actual affordance. */
    -webkit-mask-image: linear-gradient(180deg, #000 78%, transparent);
            mask-image: linear-gradient(180deg, #000 78%, transparent);
  }

  .form-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
</style>
