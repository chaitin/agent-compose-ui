<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { FitAddon } from '@xterm/addon-fit';
  import { Terminal } from 'xterm';

  import { executeRuntimeCommandStream, type RuntimeExecResult } from '../api/exec';

  export let sandboxId = '';
  export let runId = '';
  export let disabled = false;
  export let disabledReason = '';

  type CommandHistoryItem = {
    command: string;
    cwd: string;
    exitCode: number;
    success: boolean;
    at: string;
  };

  let command = 'pwd';
  let cwd = '';
  let timeoutSeconds = 120;
  let terminalNode: HTMLDivElement | null = null;
  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let abortController: AbortController | null = null;
  let running = false;
  let status = '等待命令';
  let error = '';
  let result: RuntimeExecResult | null = null;
  let history: CommandHistoryItem[] = [];

  $: canExecute = !disabled && !running && Boolean((sandboxId || runId).trim()) && Boolean(command.trim());
  $: targetLabel = sandboxId ? `sandbox ${sandboxId}` : runId ? `run ${runId}` : '-';

  onMount(() => {
    if (!terminalNode) return;
    term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      cols: 100,
      rows: 12,
      fontFamily: 'IBM Plex Mono, Fira Code, ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 2000,
      theme: {
        background: '#07111a',
        foreground: '#d8e2ec',
        cursor: '#ffbf69',
        selectionBackground: 'rgba(255, 191, 105, 0.28)',
      },
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalNode);
    resizeObserver = new ResizeObserver(() => fitTerminal());
    resizeObserver.observe(terminalNode);
    fitTerminal();
    writeLine('输入命令后会在当前 agent runtime 环境中执行。');
    writeLine('示例：pwd、ls -la、env | sort');
  });

  onDestroy(() => {
    abortController?.abort();
    resizeObserver?.disconnect();
    term?.dispose();
  });

  function fitTerminal(): void {
    try {
      fitAddon?.fit();
    } catch {
      // xterm can throw while its container is detached during route changes.
    }
  }

  function writeLine(text = ''): void {
    term?.write(`${text}\r\n`);
  }

  function writeChunk(text: string): void {
    term?.write(text);
    term?.scrollToBottom();
  }

  function clearTerminal(): void {
    term?.clear();
    result = null;
    error = '';
    status = disabled ? disabledReason || '终端不可用' : '等待命令';
  }

  function cancelCommand(): void {
    abortController?.abort();
    abortController = null;
    running = false;
    status = '已取消';
    writeLine('');
    writeLine('[canceled]');
  }

  async function executeCommand(): Promise<void> {
    const source = command.trim();
    if (!canExecute || !source) return;
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    running = true;
    status = '执行中';
    error = '';
    result = null;
    const timeoutMs = Math.max(0, Math.round(Number(timeoutSeconds || 0) * 1000));
    writeLine('');
    writeLine(`$ ${source}`);

    try {
      const finalResult = await executeRuntimeCommandStream({
        sandboxId,
        runId,
        command: source,
        cwd,
        timeoutMs,
      }, (event) => {
        if (event.type === 'started') {
          status = `执行中 · ${event.execId.slice(0, 8)}`;
        } else if (event.type === 'chunk') {
          writeChunk(event.chunk);
        } else if (event.type === 'completed') {
          result = event.result;
        }
      }, controller.signal);
      if (finalResult) {
        result = finalResult;
        status = finalResult.success ? '执行成功' : '执行失败';
        history = [
          {
            command: source,
            cwd: finalResult.cwd || cwd,
            exitCode: finalResult.exitCode,
            success: finalResult.success,
            at: new Date().toISOString(),
          },
          ...history,
        ].slice(0, 5);
        writeLine('');
        writeLine(`[exit ${finalResult.exitCode}] ${finalResult.success ? 'success' : 'failed'}`);
        if (finalResult.error) {
          writeLine(finalResult.error);
        }
      } else {
        status = '执行结束';
        writeLine('');
        writeLine('[completed]');
      }
    } catch (err) {
      if (controller.signal.aborted) {
        status = '已取消';
        return;
      }
      error = err instanceof Error ? err.message : String(err);
      status = '执行出错';
      writeLine('');
      writeLine(`[error] ${error}`);
    } finally {
      if (abortController === controller) {
        abortController = null;
      }
      running = false;
    }
  }

  function runHistoryItem(item: CommandHistoryItem): void {
    command = item.command;
    cwd = item.cwd;
  }
</script>

<div class="runtime-terminal">
  <div class="runtime-terminal-head">
    <div>
      <h3>命令终端</h3>
      <p>{targetLabel}</p>
    </div>
    <div class="runtime-terminal-status">
      {#if disabled}
        <span class="status-pill gray">{disabledReason || '不可用'}</span>
      {:else}
        <span class="status-pill" class:blue={running} class:green={result?.success} class:red={result && !result.success}>{status}</span>
      {/if}
    </div>
  </div>

  <form class="runtime-command-form" on:submit|preventDefault={executeCommand}>
    <label class="command-field">
      <span>命令</span>
      <input bind:value={command} disabled={disabled || running} autocomplete="off" spellcheck="false" placeholder="ls -la">
    </label>
    <label class="cwd-field">
      <span>工作目录</span>
      <input bind:value={cwd} disabled={disabled || running} autocomplete="off" spellcheck="false" placeholder="默认工作目录">
    </label>
    <label class="timeout-field">
      <span>超时</span>
      <input bind:value={timeoutSeconds} disabled={disabled || running} type="number" min="0" step="1">
    </label>
    <button class="primary" type="submit" disabled={!canExecute}>{running ? '执行中' : '执行'}</button>
    <button type="button" disabled={!running} on:click={cancelCommand}>取消</button>
    <button type="button" disabled={running} on:click={clearTerminal}>清空</button>
  </form>

  {#if error}
    <div class="alert danger">{error}</div>
  {/if}

  <div class="runtime-terminal-screen" bind:this={terminalNode}></div>

  {#if history.length > 0}
    <div class="runtime-command-history">
      {#each history as item}
        <button type="button" on:click={() => runHistoryItem(item)}>
          <span>{item.command}</span>
          <b class:green={item.success} class:red={!item.success}>{item.exitCode}</b>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .runtime-terminal {
    width: 100%;
    display: grid;
    grid-template-rows: auto auto minmax(var(--runtime-terminal-screen-min-height, 220px), var(--runtime-terminal-screen-track, auto)) auto;
    gap: 12px;
    align-content: start;
    text-align: left;
  }

  .runtime-terminal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .runtime-terminal-head h3 {
    margin: 0;
    font-size: 16px;
    line-height: 1.25;
  }

  .runtime-terminal-head p {
    margin: 4px 0 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .runtime-terminal-status {
    flex: 0 0 auto;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 3px 8px;
    border-radius: 999px;
    background: #eef3f8;
    color: #536274;
    font-size: var(--font-size-xs);
    font-style: normal;
    font-weight: var(--font-weight-semibold);
    line-height: 1;
    white-space: nowrap;
  }

  .status-pill.blue {
    background: var(--primary-weak);
    color: var(--primary);
  }

  .status-pill.green {
    background: var(--success-weak);
    color: var(--success);
  }

  .status-pill.red {
    background: var(--danger-weak);
    color: var(--danger);
  }

  .status-pill.gray {
    background: #eef3f8;
    color: #536274;
  }

  .runtime-command-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 86px repeat(3, auto);
    gap: 8px;
    align-items: end;
  }

  .command-field {
    grid-column: 1 / -1;
  }

  .runtime-command-form label {
    display: grid;
    gap: 4px;
    color: var(--muted);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    line-height: 1.25;
  }

  .runtime-command-form input {
    min-height: 36px;
    font-family: var(--mono);
    font-size: var(--font-size-sm);
  }

  .runtime-command-form button {
    min-height: 36px;
    white-space: nowrap;
  }

  .runtime-command-form button:disabled {
    border-color: var(--line-strong);
    background: #f1f4f8;
    color: #9aa6b2;
    box-shadow: none;
  }

  .runtime-terminal-screen {
    height: var(--runtime-terminal-screen-height, 260px);
    min-height: var(--runtime-terminal-screen-min-height, 220px);
    overflow: hidden;
    border: 1px solid rgba(9, 23, 38, 0.16);
    border-radius: 8px;
    background: #07111a;
    padding: 8px;
  }

  :global(.runtime-terminal-screen .xterm) {
    height: 100%;
  }

  .runtime-command-history {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .runtime-command-history button {
    max-width: 100%;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 4px 8px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: var(--font-size-xs);
  }

  .runtime-command-history span {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-command-history b {
    color: var(--muted);
  }

  .runtime-command-history b.green {
    color: var(--success);
  }

  .runtime-command-history b.red {
    color: var(--danger);
  }

  @media (max-width: 920px) {
    .runtime-command-form {
      grid-template-columns: minmax(0, 1fr) 86px repeat(3, auto);
    }
  }

  @media (max-width: 640px) {
    .runtime-terminal-head {
      display: grid;
    }

    .runtime-command-form {
      grid-template-columns: 1fr;
    }

    .runtime-terminal-screen {
      height: var(--runtime-terminal-screen-mobile-height, 240px);
    }
  }
</style>
