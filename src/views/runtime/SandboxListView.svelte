<script lang="ts">
  import { onMount } from 'svelte';
  import { ExecCommand, ExecRequest, GetSandboxStatsRequest, MetricStatus, RemoveSandboxRequest, ResumeSandboxRequest, StopSandboxRequest, type MetricValue, type Sandbox, type SandboxStats } from '../../gen/agentcompose/v2/agentcompose_pb';
  import SessionTerminal from '../../pages/session/SessionTerminal.svelte';
  import FileBrowser from '../../pages/session/FileBrowser.svelte';
  import { execService, sandboxService } from '../../lib/rpc';
  import type { SandboxLifecycle } from '../../lib/runtime-inventory';
  import { filterSandboxes, listAllSandboxes, sandboxLifecycle } from '../../lib/sandbox-inventory';
  import { formatMetric, sandboxJupyterPath } from '../../lib/sandboxes';
  import { store } from '../../lib/stores.svelte';
  import { sandboxResumeErrorMessage } from '../../lib/sandbox-resume-error';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';

  let inventory: Sandbox[] = $state([]);
  let loading = $state(true);
  let stats: Record<string, SandboxStats | undefined> = $state({});
  type StatsRefresh = { loading: boolean; error: string; stale: boolean };
  let statsRefresh: Record<string, StatsRefresh | undefined> = $state({});
  let commands: Record<string, string> = $state({});
  let outputs: Record<string, string> = $state({});
  let busy: Record<string, boolean> = $state({});
  let lifecycle: Record<string, SandboxLifecycle | undefined> = $state({});
  let loadError = $state('');
  let inventoryGeneration = 0;
  const metricStatusLabels: Record<MetricStatus, string> = {
    [MetricStatus.UNSPECIFIED]: '未指定', [MetricStatus.OK]: '可用',
    [MetricStatus.UNKNOWN]: '未知', [MetricStatus.UNAVAILABLE]: '不可用',
  };
  function metricText(metric?: MetricValue) {
    const status = metricStatusLabels[metric?.status ?? MetricStatus.UNSPECIFIED];
    const evidence = `原状态：${status}${metric?.message ? `：${metric.message}` : ''}`;
    if (metric?.status === MetricStatus.OK && metric.value != null) return `${formatMetric(metric)}（${evidence}）`;
    if (metric?.status === MetricStatus.OK) return `无有效值（${evidence}）`;
    return `${status}（${evidence}）`;
  }
  type SandboxTool = 'terminal' | 'files' | '';
  function toolFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const tool = params.get('sandboxTool');
    return { tool: tool === 'terminal' || tool === 'files' ? tool : '' as SandboxTool, sandboxId: params.get('sandboxId') || '' };
  }
  let activeTool: SandboxTool = $state('');
  let activeSandboxId = $state('');
  let toolProjectId = $state('');
  let loadedProjectId = store.activeProjectId;
  function syncToolFromUrl() {
    const next = toolFromUrl();
    const projectId = store.activeProjectId;
    if (next.tool && next.sandboxId && projectId && inventory.some((item) => item.sandboxId === next.sandboxId) && lifecycle[next.sandboxId] === 'running') {
      activeTool = next.tool;
      activeSandboxId = next.sandboxId;
      toolProjectId = projectId;
      return;
    }
    if (next.tool && next.sandboxId && inventory.some((item) => item.sandboxId === next.sandboxId) && lifecycle[next.sandboxId] === 'detecting') return;
    closeTool();
  }
  onMount(() => {
    window.addEventListener('popstate', syncToolFromUrl);
    return () => window.removeEventListener('popstate', syncToolFromUrl);
  });

  function openTool(tool: Exclude<SandboxTool, ''>, sandboxId: string) {
    if (!store.activeProjectId || !inventory.some((item) => item.sandboxId === sandboxId) || lifecycle[sandboxId] !== 'running') return;
    activeTool = tool; activeSandboxId = sandboxId; toolProjectId = store.activeProjectId;
    window.history.pushState(null, '', `?sandboxTool=${tool}&sandboxId=${encodeURIComponent(sandboxId)}${window.location.hash}`);
  }

  function closeTool() {
    activeTool = ''; activeSandboxId = ''; toolProjectId = '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  }

  async function load() {
    const projectId = store.activeProjectId;
    if (projectId !== loadedProjectId) {
      loadedProjectId = projectId;
      inventoryGeneration += 1;
      inventory = [];
      stats = {}; statsRefresh = {}; commands = {}; outputs = {}; busy = {}; lifecycle = {};
      closeTool();
    }
    if (!projectId) { inventory = []; loading = false; return; }
    const agentName = store.runtimeView.agentName;
    if (!agentName) { inventory = []; loading = false; return; }
    const loadGeneration = ++inventoryGeneration;
    loading = true; loadError = '';
    try {
      const records = await listAllSandboxes((request, options) => sandboxService.listSandboxes(request, options));
      if (loadGeneration === inventoryGeneration && projectId === store.activeProjectId && agentName === store.runtimeView.agentName) {
        inventory = filterSandboxes(records, { projectId, agentName });
        lifecycle = Object.fromEntries(inventory.map(item => [item.sandboxId, sandboxLifecycle(item.status)]));
        syncToolFromUrl();
      }
    } catch (error: any) {
      if (loadGeneration === inventoryGeneration && projectId === store.activeProjectId && agentName === store.runtimeView.agentName) {
        loadError = error?.message || '加载 Sandbox 清单失败';
        store.addToast(loadError, 'error');
      }
    } finally {
      if (loadGeneration === inventoryGeneration && projectId === store.activeProjectId && agentName === store.runtimeView.agentName) loading = false;
    }
  }

  $effect(() => { void store.runtimeRefreshVersion; void load(); });

  async function loadStats(item: Sandbox) {
    const projectId = store.activeProjectId;
    const generation = inventoryGeneration;
    statsRefresh[item.sandboxId] = { loading: true, error: '', stale: Boolean(stats[item.sandboxId]) };
    busy[item.sandboxId] = true;
    try {
      const response = await sandboxService.getSandboxStats(new GetSandboxStatsRequest({ sandboxId: item.sandboxId }));
      if (projectId !== store.activeProjectId || generation !== inventoryGeneration || !inventory.some((entry) => entry.sandboxId === item.sandboxId)) return;
      stats[item.sandboxId] = response.stats;
      statsRefresh[item.sandboxId] = { loading: false, error: '', stale: false };
    } catch (error: any) {
      if (projectId === store.activeProjectId && generation === inventoryGeneration) {
        const message = error?.message || '读取 Sandbox 指标失败';
        statsRefresh[item.sandboxId] = { loading: false, error: message, stale: Boolean(stats[item.sandboxId]) };
        store.addToast(message, 'error');
      }
    }
    finally { if (projectId === store.activeProjectId && generation === inventoryGeneration) busy[item.sandboxId] = false; }
  }

  async function execute(item: Sandbox) {
    const command = commands[item.sandboxId]?.trim();
    if (!command) return;
    busy[item.sandboxId] = true;
    try {
      const response = await execService.exec(new ExecRequest({ target: { case: 'sandboxId', value: item.sandboxId }, command: new ExecCommand({ command: '/bin/sh', args: ['-lc', command] }) }));
      outputs[item.sandboxId] = response.result?.output || response.result?.stdout || response.result?.stderr || response.result?.error || '命令已完成（无输出）';
    } catch (error: any) { outputs[item.sandboxId] = error?.message || '执行失败'; }
    finally { busy[item.sandboxId] = false; }
  }

  async function resume(item: Sandbox) {
    if (!store.activeProjectId) return;
    if (!window.confirm(`恢复 Sandbox ${item.sandboxId}？`)) return;
    busy[item.sandboxId] = true;
    try {
      await sandboxService.resumeSandbox(new ResumeSandboxRequest({ sandboxId: item.sandboxId }));
      store.addToast('Sandbox 已恢复', 'success');
      store.triggerRuntimeRefresh();
    } catch (error: unknown) { store.addToast(sandboxResumeErrorMessage(error), 'error'); }
    finally { busy[item.sandboxId] = false; }
  }

  async function stop(item: Sandbox) {
    if (!store.activeProjectId || lifecycle[item.sandboxId] !== 'running') return;
    if (!window.confirm(`停止 Sandbox ${item.sandboxId}？Sandbox 数据将保留，可再次恢复。`)) return;
    busy[item.sandboxId] = true;
    try {
      await sandboxService.stopSandbox(new StopSandboxRequest({ sandboxId: item.sandboxId }));
      store.addToast('Sandbox 已停止', 'success');
      store.triggerRuntimeRefresh();
      await load();
    } catch (error: any) { store.addToast(error?.message || '停止 Sandbox 失败', 'error'); }
    finally { busy[item.sandboxId] = false; }
  }

  function openJupyter(item: Sandbox) {
    window.open(sandboxJupyterPath(item.sandboxId), '_blank', 'noopener,noreferrer');
  }

  async function remove(item: Sandbox) {
    const state = lifecycle[item.sandboxId];
    if (state !== 'running' && state !== 'stopped') return;
    const force = state === 'running';
    if (!window.confirm(`${force ? '强制删除' : '删除'} Sandbox ${item.sandboxId}？此操作不可撤销。`)) return;
    busy[item.sandboxId] = true;
    try {
      await sandboxService.removeSandbox(new RemoveSandboxRequest({ sandboxId: item.sandboxId, force }));
      store.addToast('Sandbox 已移除', 'success');
      await load();
    } catch (error: any) { store.addToast(error?.message || '移除 Sandbox 失败', 'error'); }
    finally { busy[item.sandboxId] = false; }
  }

  const lifecycleLabels: Record<SandboxLifecycle, string> = {
    detecting: '检测中', running: '运行中', stopped: '已停止 · 可恢复', destroyed: '已销毁', unknown: '状态未知',
  };
  function timestamp(value: Sandbox['createdAt']): string {
    return value?.toDate().toLocaleString() ?? '-';
  }
</script>

<div class="root">
  <div class="breadcrumb-wrap"><RuntimeBreadcrumb eyebrow={store.runtimeView.agentName || 'Agent'} title="Sandbox 清单" onBack={() => store.navigateBack()} actions={[{ label: '刷新', onclick: load, variant: 'primary' }]} /></div>
  {#if loadError}<div class="state error">加载失败：{loadError}<button onclick={load}>重试</button></div>
  {:else if loading}<div class="state">加载中...</div>
  {:else if inventory.length === 0}<div class="state">该 Agent 暂无 Sandbox</div>
  {:else}<div class="list">
    {#each inventory as item (item.sandboxId)}
      {@const state = lifecycle[item.sandboxId] ?? 'unknown'}
      <article class:running={state === 'running'} class:stopped={state === 'stopped'} class:destroyed={state === 'destroyed'} class:unknown={state === 'unknown'}>
        <div class="identity"><strong>{lifecycleLabels[state]}</strong><code>{item.sandboxId}</code><span>{item.title || item.agentName || '-'}</span><time>{timestamp(item.updatedAt)}</time></div>
        <div class="metadata"><span>Driver {item.driver || '-'}</span><span>Image {item.image || '-'}</span><span>{item.workspacePath || '-'}</span><span>Trigger {item.triggerSource || '-'}</span><span>Created {timestamp(item.createdAt)}</span><span>Updated {timestamp(item.updatedAt)}</span><span>{item.cellCount} cells</span><span>{item.eventCount} events</span><span>Proxy {item.proxyPath || '-'}</span></div>
        <div class="actions">
          <button aria-label={`查看 ${item.sandboxId} 详情`} onclick={() => store.navigateTo('sandbox-detail', { sandboxId: item.sandboxId })}>查看详情</button>
          {#if state === 'running'}
            <button onclick={() => openTool('terminal', item.sandboxId)}>Terminal</button><button onclick={() => openTool('files', item.sandboxId)}>Files</button><button onclick={() => openJupyter(item)}>Jupyter</button><button onclick={() => loadStats(item)} disabled={busy[item.sandboxId]}>Stats</button><input aria-label={`执行命令 ${item.sandboxId}`} bind:value={commands[item.sandboxId]} placeholder="输入 shell 命令"/><button onclick={() => execute(item)} disabled={busy[item.sandboxId]}>Exec</button><button onclick={() => stop(item)} disabled={busy[item.sandboxId]}>{busy[item.sandboxId] ? '停止中' : '停止'}</button><button class="danger" onclick={() => remove(item)} disabled={busy[item.sandboxId]}>强制删除</button>
          {:else if state === 'stopped'}
            <button onclick={() => resume(item)} disabled={busy[item.sandboxId]}>恢复</button><button class="danger" onclick={() => remove(item)} disabled={busy[item.sandboxId]}>删除 Sandbox</button>
          {:else if state === 'unknown'}
            <button onclick={() => loadStats(item)} disabled={busy[item.sandboxId]}>重新检测</button>
          {/if}
        </div>
        {#if statsRefresh[item.sandboxId]?.loading}<div class="stats-status">指标加载中{statsRefresh[item.sandboxId]?.stale ? '，当前显示旧样本' : ''}</div>{:else if statsRefresh[item.sandboxId]?.error}<div class="stats-status error">指标加载失败：{statsRefresh[item.sandboxId]?.error}{statsRefresh[item.sandboxId]?.stale ? '；当前显示旧样本' : ''}</div>{/if}
        {#if state === 'destroyed'}<div class="stats-status">运行环境已销毁；实时 Terminal、Files、Jupyter 和 Stats 不再可用。</div>{/if}
        {#if stats[item.sandboxId]}{@const sandboxStats = stats[item.sandboxId]!}<div class="metrics"><span>Driver {sandboxStats.driver || '-'}</span><span>采样时间 {sandboxStats.sampledAt || '未提供'}</span><span>CPU {metricText(sandboxStats.cpuPercent)}</span><span>内存使用 {metricText(sandboxStats.memoryUsageBytes)}</span><span>内存上限 {metricText(sandboxStats.memoryLimitBytes)}</span><span>内存占比 {metricText(sandboxStats.memoryPercent)}</span><span>网络接收 {metricText(sandboxStats.networkRxBytes)}</span><span>网络发送 {metricText(sandboxStats.networkTxBytes)}</span><span>块读取 {metricText(sandboxStats.blockReadBytes)}</span><span>块写入 {metricText(sandboxStats.blockWriteBytes)}</span><span>运行时间 {metricText(sandboxStats.uptimeSeconds)}</span></div>{/if}
        {#if outputs[item.sandboxId]}<pre>{outputs[item.sandboxId]}</pre>{/if}
      </article>
    {/each}
  </div>{/if}
  <div class="lifecycle-note">清单与生命周期来自 V2 Sandbox inventory；Stats 仅在需要时读取。</div>
</div>
{#if activeTool && activeSandboxId && toolProjectId === store.activeProjectId}<div class="tool-overlay"><div class="tool-bar"><strong>{activeTool === 'terminal' ? 'Terminal' : 'Files'}</strong><code>{activeSandboxId}</code><button onclick={closeTool}>关闭</button></div><div class="tool-body">{#key `${toolProjectId}:${activeTool}:${activeSandboxId}`}{#if activeTool === 'terminal'}<SessionTerminal sandboxId={activeSandboxId} />{:else}<FileBrowser sandboxId={activeSandboxId} />{/if}{/key}</div></div>{/if}

<style>.root{height:100%;overflow:auto;padding:0 14px 14px}.breadcrumb-wrap{margin:0 -14px 12px}button,input{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);padding:6px 8px}.state{padding:30px;text-align:center;color:var(--text-muted)}.state.error{color:var(--accent-red)}.list{display:grid;gap:8px}article{padding:10px;border:1px solid var(--border-color);border-left:3px solid var(--border-color);border-radius:5px;background:var(--bg-secondary)}article.running{border-left-color:var(--accent-green)}article.stopped{border-left-color:var(--accent-orange)}article.destroyed{border-left-color:var(--text-muted);opacity:.86}article.unknown{border-left-color:var(--accent-yellow)}.identity{display:grid;grid-template-columns:120px minmax(0,1fr) minmax(0,1fr) 180px;gap:8px;align-items:center}.identity strong{font-size:var(--font-size-xs)}.metadata,.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:7px 14px;margin-top:8px;padding:7px;background:var(--bg-primary)}code,span,time{overflow:hidden;text-overflow:ellipsis;font-size:var(--font-size-xs);color:var(--text-muted)}.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.actions input{flex:1;min-width:160px;background:var(--bg-primary)}button:focus-visible,input:focus-visible{outline:2px solid var(--accent-blue);outline-offset:2px}.danger{color:var(--accent-red)}pre{max-height:180px;overflow:auto;padding:8px;background:var(--bg-primary);font-size:var(--font-size-xs);white-space:pre-wrap}.stats-status,.lifecycle-note{margin-top:8px;color:var(--text-muted);font-size:var(--font-size-xs)}.stats-status.error{color:var(--accent-red)}.lifecycle-note{padding:8px;border:1px solid var(--border-color);background:var(--bg-secondary)}.tool-overlay{position:absolute;inset:8px;z-index:20;display:flex;flex-direction:column;border:1px solid var(--border-color);background:var(--bg-primary);box-shadow:0 8px 30px #0008}.tool-bar{display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border-color)}.tool-bar code{flex:1}.tool-body{flex:1;min-height:0}@media(max-width:760px){.identity{grid-template-columns:1fr}}</style>
