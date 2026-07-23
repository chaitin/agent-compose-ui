<script lang="ts">
  import { untrack } from 'svelte';
  import { runService, sandboxService } from '../lib/rpc';
  import { store } from '../lib/stores.svelte';
  import {
    StartRunRequest,
    RunSandboxCleanupPolicy,
  } from '../gen/agentcompose/v2/agentcompose_pb';
  import { buildRunAgentRequest, type RunRequestInput } from '../lib/run-controls';
  import { listAllSandboxes, filterSandboxes } from '../lib/sandbox-inventory';
  import { assertManagedWorkspace } from '../lib/workspace/preflight';

  let { onclose = () => {}, oncreated = () => {}, onstarted = () => {}, prefilledAgent = '', prefilledPrompt = '' }: {
    onclose?: () => void;
    oncreated?: () => void;
    onstarted?: (runId: string) => void;
    prefilledAgent?: string;
    prefilledPrompt?: string;
  } = $props();

  let agentName = $state(untrack(() => prefilledAgent));
  let form = $state(untrack(() => ({
    mode: 'prompt' as RunRequestInput['mode'],
    input: prefilledPrompt,
    driver: '',
    sandboxId: '',
    cleanupPolicy: RunSandboxCleanupPolicy.UNSPECIFIED,
    jupyterEnabled: false,
    jupyterExpose: false,
  })));
  const cleanupOptions = [
    { label: '默认', value: RunSandboxCleanupPolicy.UNSPECIFIED },
    { label: '运行后停止', value: RunSandboxCleanupPolicy.STOP_ON_COMPLETION },
    { label: '保持运行', value: RunSandboxCleanupPolicy.KEEP_RUNNING },
    { label: '运行后移除', value: RunSandboxCleanupPolicy.REMOVE_ON_COMPLETION },
  ];
  let driverOptions: string[] = $state([]);
  let sandboxOptions: string[] = $state([]);

  $effect(() => {
    const projectId = store.activeProjectId;
    const name = agentName;
    if (!projectId || !name) return;
    let cancelled = false;
    void (async () => {
      try {
        const records = await listAllSandboxes((request, options) => sandboxService.listSandboxes(request, options));
        if (cancelled) return;
        const scoped = filterSandboxes(records, { projectId, agentName: name });
        sandboxOptions = scoped.map((record) => record.sandboxId).filter(Boolean);
        driverOptions = Array.from(new Set(scoped.map((record) => record.driver).filter(Boolean)));
      } catch {
        // 加载已有 Sandbox 失败时保持空列表，用户仍可手动填写
      }
    })();
    return () => { cancelled = true; };
  });
  let validationError = $state('');
  let running: boolean = $state(false);

  function request() {
    return buildRunAgentRequest({
      projectId: store.activeProjectId,
      agentName,
      ...form,
    });
  }

  async function run() {
    if (!agentName.trim() || !store.activeProjectId) return;
    let req;
    try {
      req = request();
      if (!req.sandboxId) {
        const sourcePath = store.projects?.find((project) => project.summary.projectId === store.activeProjectId)?.summary.sourcePath || '';
        await assertManagedWorkspace({ yaml: store.editorContent, sourcePath });
      }
      validationError = '';
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      return;
    }
    running = true;

    try {
      const response = await runService.startRun(new StartRunRequest({ run: req }));
      const runId = response.run?.runId || '';
      running = false;
      if (!runId) {
        store.addToast('运行已提交，但未返回 Run ID', 'error');
        return;
      }
      onstarted(runId);
      store.addToast(`已提交运行 ${runId}`, 'success');
      oncreated();
      onclose();
      store.navigateTo('run-detail', { agentName, runId });
    } catch (e: any) {
      store.addToast(e.message || '启动运行失败', 'error');
      running = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
  function close() {
    running = false;
    onclose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-overlay" onclick={close} role="none"></div>
<div class="modal" role="dialog" aria-label={`手动运行 ${agentName}`}>
  <div class="modal-header">
    <h3>运行智能体</h3>
    <button class="close-btn" onclick={close}>x</button>
  </div>
  <div class="modal-body">
    <label class="field">
      <span class="label">智能体名称</span>
      <input
        type="text"
        class="text-input"
        value={agentName}
        placeholder="智能体名称"
        disabled
      />
    </label>
    <label class="field">
      <span class="label">输入模式</span>
      <select aria-label="输入模式" value={form.mode} onchange={(event) => form.mode = event.currentTarget.value as RunRequestInput['mode']} disabled={running}>
        <option value="prompt">Prompt（对话）</option>
        <option value="command">命令（Command）</option>
      </select>
    </label>
    <label class="field">
      <span class="label">{form.mode === 'command' ? '命令' : 'Prompt 内容'}</span>
      <textarea
        aria-label="运行内容"
        class="text-input"
        rows="6"
        value={form.input}
        placeholder={form.mode === 'command' ? '输入要执行的命令，例如 bun test' : '输入 Prompt 内容'}
        disabled={running}
        oninput={(event) => { form.input = event.currentTarget.value; validationError = ''; }}
      ></textarea>
    </label>
    <div class="form-row">
      <label class="field">
        <span class="label">驱动</span>
        <input aria-label="驱动" type="text" class="text-input" list="run-agent-driver-options" value={form.driver} placeholder="留空使用默认驱动" disabled={running} oninput={(event) => form.driver = event.currentTarget.value} />
        <datalist id="run-agent-driver-options">{#each driverOptions as driver}<option value={driver}></option>{/each}</datalist>
      </label>
      <label class="field">
        <span class="label">Sandbox ID</span>
        <input aria-label="Sandbox ID" type="text" class="text-input" list="run-agent-sandbox-options" value={form.sandboxId} placeholder="留空新建 Sandbox" disabled={running} oninput={(event) => form.sandboxId = event.currentTarget.value} />
        <datalist id="run-agent-sandbox-options">{#each sandboxOptions as sandboxId}<option value={sandboxId}></option>{/each}</datalist>
      </label>
    </div>
    <label class="field">
      <span class="label">清理策略</span>
      <select aria-label="清理策略" value={form.cleanupPolicy} onchange={(event) => form.cleanupPolicy = Number(event.currentTarget.value)} disabled={running}>
        {#each cleanupOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <fieldset class="checkbox-group">
      <label class="checkbox"><input type="checkbox" aria-label="启用 Jupyter" checked={form.jupyterEnabled} onchange={(event) => { form.jupyterEnabled = event.currentTarget.checked; if (!form.jupyterEnabled) form.jupyterExpose = false; }} disabled={running} /> 启用 Jupyter</label>
      <label class="checkbox"><input type="checkbox" aria-label="暴露 Jupyter 端口" checked={form.jupyterExpose} onchange={(event) => form.jupyterExpose = event.currentTarget.checked} disabled={running || !form.jupyterEnabled} /> 暴露端口</label>
    </fieldset>
    {#if validationError}<div class="validation-error" role="alert">{validationError}</div>{/if}
    <div class="btn-row">
      <button class="run-btn" onclick={run} disabled={running || !agentName.trim() || !form.input.trim() || !store.activeProjectId}>
        {running ? '运行中...' : '运行'}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 80;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 600px;
    max-width: 90vw;
    max-height: 85vh;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    z-index: 90;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
  }
  .modal-header h3 { margin: 0; font-size: var(--font-size-xl); }
  .close-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 18px;
    cursor: pointer;
  }
  .modal-body {
    padding: 14px 16px;
    overflow-y: auto;
    flex: 1;
  }
  .validation-error{margin:7px 0 10px;padding:8px;border-left:3px solid var(--accent-red);background:var(--bg-secondary);color:var(--accent-red);font-size:var(--font-size-sm)}
  textarea.text-input{resize:vertical;min-height:120px;font-family:var(--font-mono);line-height:1.5}
  .form-row{display:flex;gap:12px}
  .form-row .field{flex:1;margin-bottom:12px}
  .checkbox-group{display:flex;gap:16px;margin-bottom:12px;border:none;padding:0}
  .checkbox{display:flex;align-items:center;gap:6px;font-size:var(--font-size-md);color:var(--text-secondary)}
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  select { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); padding: 6px 10px; }
  .label {
    font-size: var(--font-size-md);
    color: var(--text-secondary);
    font-weight: 500;
  }
  .text-input {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--font-size-md);
    padding: 6px 10px;
  }
  .btn-row {
    margin-bottom: 10px;
  }
  .run-btn {
    padding: 5px 20px;
    background: var(--accent-blue);
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-md);
    cursor: pointer;
    font-family: inherit;
  }
  .run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
