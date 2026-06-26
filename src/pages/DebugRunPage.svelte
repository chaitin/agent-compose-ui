<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';

  import { getProjectRunDebugTarget } from '../api/runs';
  import { getWorkSession, type WorkSessionDetail } from '../api/sessions';
  import { formatBeijingTime } from '../time';

  export let runId = '';

  const dispatch = createEventDispatcher<{ navigateRuns: string }>();

  let session: WorkSessionDetail | null = null;
  let loading = false;
  let error = '';
  let notebookUrl = '';
  let debugStatus = '未知';
  let debugMessage = '';
  let sessionId = '';

  $: notebookUrl = statusLabel(session?.status || '') === '运行中' ? session?.notebookUrl || '' : '';
  $: debugStatus = statusLabel(session?.status || '');
  $: debugMessage = debugEnvironmentMessage(session, notebookUrl);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    if (!runId) return;
    loading = true;
    error = '';
    sessionId = '';
    try {
      session = await loadDebugSession(runId);
      sessionId = session.id;
    } catch (err) {
      session = null;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadDebugSession(id: string): Promise<WorkSessionDetail> {
    try {
      return await getWorkSession(id);
    } catch {
      const target = await getProjectRunDebugTarget(id);
      return getWorkSession(target.sessionId);
    }
  }

  function statusLabel(status: string): string {
    const normalized = status.toUpperCase();
    if (status === '启动中' || normalized === 'PENDING') return '启动中';
    if (status === '运行中' || normalized === 'RUNNING') return '运行中';
    if (status === '启动失败' || normalized === 'FAILED') return '启动失败';
    if (status === '已停止' || normalized === 'STOPPED') return '已停止';
    return status || (loading ? '加载中' : '未知');
  }

  function statusTone(status: string): 'blue' | 'green' | 'red' | 'gray' {
    const normalized = statusLabel(status);
    // Keep status colors aligned with the runs center (RunsPage.statusClass):
    // in-progress states are blue, terminal-success states green, failures red.
    if (['启动失败', '失败', '跳过', '已取消'].includes(normalized)) return 'red';
    if (['成功', '已停止'].includes(normalized)) return 'green';
    if (['启动中', '等待中', '运行中', '恢复中', '停止中'].includes(normalized)) return 'blue';
    return 'gray';
  }

  function debugEnvironmentMessage(value: WorkSessionDetail | null, url: string): string {
    if (loading) return '正在连接调试环境。';
    if (!value) return '当前运行不是可直接调试的工作会话，或后端尚未提供调试入口。';
    const normalized = statusLabel(value.status);
    if (normalized === '启动中') return '正在启动 Jupyter 调试环境。';
    if (normalized === '运行中' && url) return '复用当前运行的 Jupyter 调试环境。';
    if (normalized === '运行中') return '当前会话已运行，等待后端返回 Jupyter URL。';
    if (normalized === '启动失败') return '调试环境启动失败，请查看运行事件和错误摘要。';
    if (normalized === '已停止') return '调试环境已停止，可返回运行中心恢复会话。';
    return '当前会话状态暂不支持打开调试入口。';
  }

  function formatTime(value: string | undefined): string {
    return value ? formatBeijingTime(value) : '-';
  }

  function tagValue(name: string): string {
    return session?.tags.find((tag) => tag.name === name)?.value || '-';
  }
</script>

{#if error}
  <div class="alert danger">{error}</div>
{/if}

<div class="page-title">
  <div>
    <h2>调试工具</h2>
  </div>
  <div class="toolbar">
    <button on:click={() => dispatch('navigateRuns', sessionId || runId)}>返回运行中心</button>
    <button on:click={load}>{loading ? '连接中...' : '刷新 / 重新连接'}</button>
  </div>
</div>

<div class="debug-layout">
  <section class="debug-card">
    <div class="debug-card-head">
      <h3>调试环境</h3>
    </div>
    <div class="descriptions-small debug-descriptions">
      <div><span>runId</span><b>{#if runId}<span class="mono-text">{runId}</span>{:else}<span class="muted">-</span>{/if}</b></div>
      <div><span>sessionId</span><b>{#if sessionId}<span class="mono-text">{sessionId}</span>{:else}<span class="muted">-</span>{/if}</b></div>
      <div>
        <span>Jupyter 状态</span>
        <b><em class={`home-pill ${statusTone(session?.status || '')}`}>{debugStatus}</em></b>
      </div>
      <div>
        <span>访问入口</span>
        <b>
          {#if notebookUrl}
            <a class="button-link primary" href={notebookUrl} target="_blank" rel="noreferrer">打开 Jupyter</a>
          {:else}
            <span class="muted">等待后端返回 Jupyter URL</span>
          {/if}
        </b>
      </div>
      <div><span>状态说明</span><b>{debugMessage}</b></div>
    </div>
  </section>

  <section class="debug-card">
    <div class="debug-card-head">
      <h3>会话信息</h3>
    </div>
    <div class="descriptions-small debug-descriptions">
      <div><span>代理路径</span><b>{#if session?.proxyPath}<span class="mono-text">{session.proxyPath}</span>{:else}<span class="muted">-</span>{/if}</b></div>
      <div><span>运行环境</span><b>{session ? `${session.driver || '-'} · ${session.guestImage || '-'}` : '-'}</b></div>
      <div><span>创建时间</span><b>{formatTime(session?.createdAt)}</b></div>
      <div><span>更新时间</span><b>{formatTime(session?.updatedAt)}</b></div>
    </div>
  </section>

  <section class="debug-card wide">
    <div class="debug-card-head">
      <h3>上下文摘要</h3>
    </div>
    <div class="descriptions-small debug-descriptions">
      <div><span>运行基础信息</span><b>{session ? `${session.title || session.id} · 工作会话 · ${debugStatus}` : '未找到运行记录'}</b></div>
      <div><span>自动化任务</span><b>{tagValue('loader_id') !== '-' ? tagValue('loader_id') : '仅自动化运行进入调试工具'}</b></div>
      <div><span>任务输入快照</span><b>{#if tagValue('task_input') !== '-'}<pre>{tagValue('task_input')}</pre>{:else}<span class="muted">-</span>{/if}</b></div>
      <div><span>触发上下文</span><b>{#if tagValue('trigger_context') !== '-'}<pre>{tagValue('trigger_context')}</pre>{:else}<span class="muted">-</span>{/if}</b></div>
      <div><span>工作文件来源</span><b>{#if session?.workspacePath}<span class="mono-text">{session.workspacePath}</span>{:else}<span class="muted">-</span>{/if}</b></div>
      <div><span>能力接入事实</span><b>{tagValue('capability_gateway') !== '-' ? tagValue('capability_gateway') : '-'}</b></div>
      <div><span>Secret 规则</span><b>Secret 只展示已设置，不在页面、URL、日志或错误信息中明文展示。</b></div>
    </div>
  </section>
</div>
