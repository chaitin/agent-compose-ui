<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { ExecCommand, ExecRequest, ExecStreamEventType, EnvVarSpec } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { execService } from '../../lib/rpc';
  import '@xterm/xterm/css/xterm.css';

  let { sandboxId }: { sandboxId: string; autoConnect?: boolean } = $props();
  let host: HTMLDivElement;
  let terminal: Terminal | undefined;
  let fit: FitAddon | undefined;
  let cwd = '/';
  let input = '';
  let cursor = 0;
  let history: string[] = [];
  let historyIndex = -1;
  let savedInput = '';
  let running = $state(false);
  let columns = 80;
  let active: AbortController | undefined;

  function prompt() { return `\r\n\x1b[36m${cwd}\x1b[0m$ `; }
  function moveCursor(amount: number) { if (amount > 0) terminal?.write(`\x1b[${amount}C`); else if (amount < 0) terminal?.write(`\x1b[${-amount}D`); }
  function redraw() {
    terminal?.write(`\r\x1b[0K\x1b[36m${cwd}\x1b[0m$ ${input}`);
    moveCursor(-(input.length - cursor));
  }
  function nextPrompt() {
    terminal?.write(prompt()); input = ''; cursor = 0; historyIndex = -1; savedInput = ''; running = false;
  }
  function normalizePath(path: string) {
    const parts: string[] = [];
    for (const part of path.split('/')) { if (!part || part === '.') continue; if (part === '..') parts.pop(); else parts.push(part); }
    return `/${parts.join('/')}`;
  }
  function resolvePath(path: string) { return normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`); }
  function cdTarget(command: string): string | undefined {
    const trimmed = command.trim();
    if (trimmed === 'cd' || trimmed === 'cd .' || trimmed === 'cd ~' || trimmed === 'cd -') return trimmed === 'cd .' ? cwd : undefined;
    if (!trimmed.startsWith('cd ')) return undefined;
    return resolvePath(trimmed.slice(3).trim().replace(/^['"](.*)['"]$/, '$1'));
  }
  function rewriteForDisplay(command: string) {
    const tokens = command.trim().split(/\s+/); const program = tokens[0];
    if (program === 'ls' && !tokens.some(item => item === '-1' || item.includes('l') || item.startsWith('--color'))) return `ls -C --color=always ${tokens.slice(1).join(' ')}`.trim();
    if (['grep', 'egrep', 'fgrep'].includes(program) && !tokens.some(item => item.startsWith('--color'))) return `${program} --color=always ${tokens.slice(1).join(' ')}`.trim();
    return command;
  }
  function terminalText(chunk: string) { return chunk.replace(/\r?\n/g, '\r\n').replace(/\t/g, '        '); }

  async function stream(command: string, args: string[], requestCwd = cwd) {
    active?.abort(); active = new AbortController(); let output = ''; let resultError = '';
    const request = new ExecRequest({
      target: { case: 'sandboxId', value: sandboxId }, command: new ExecCommand({ command, args }), cwd: requestCwd,
      env: [new EnvVarSpec({ name: 'COLUMNS', value: String(columns) })], timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024,
    });
    for await (const event of execService.execStream(request, { signal: active.signal })) {
      if (event.eventType === ExecStreamEventType.OUTPUT && event.chunk) { const text = terminalText(event.chunk); terminal?.write(text); output += event.chunk; }
      if (event.result?.error) resultError = event.result.error;
    }
    if (resultError) throw new Error(resultError);
    return output;
  }

  async function run(command: string) {
    if (!command.trim()) { nextPrompt(); return; }
    if (history.at(-1) !== command) history = [...history, command];
    historyIndex = -1; running = true;
    try {
      const target = cdTarget(command);
      if (command.trim().startsWith('cd') && target === undefined) terminal?.write('\x1b[31mcd: ~ and - are not available in this console\x1b[0m');
      else if (target !== undefined) {
        const result = await stream('/bin/sh', ['-c', 'test -d "$1" && printf OK || printf MISSING', 'cd-check', target], '/');
        if (result.trim() === 'OK') cwd = target; else terminal?.write(`\x1b[31mcd: no such directory: ${target}\x1b[0m`);
      } else await stream('/bin/sh', ['-lc', rewriteForDisplay(command)]);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) terminal?.write(`\r\n\x1b[31m[错误] ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m`);
    }
    nextPrompt();
  }

  function handleData(data: string) {
    if (running) return;
    for (const character of data) {
      const code = character.charCodeAt(0);
      if (code === 13) { const command = input; terminal?.write('\r\n'); input = ''; cursor = 0; void run(command); return; }
      if (code === 127) { if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor--; redraw(); } continue; }
      if (code === 3) { terminal?.write('^C'); input = ''; cursor = 0; nextPrompt(); continue; }
      if (code === 12) { terminal?.write('\x1b[2J\x1b[H'); nextPrompt(); continue; }
      if (code === 21) { input = ''; cursor = 0; redraw(); continue; }
      if (code === 23) { const before = input.slice(0, cursor); const trimmed = before.replace(/[^\s]+\s*$/, ''); input = trimmed + input.slice(cursor); cursor = trimmed.length; redraw(); continue; }
      if (code === 9) { input = input.slice(0, cursor) + '  ' + input.slice(cursor); cursor += 2; redraw(); continue; }
      if (code >= 32 && code < 127) { input = input.slice(0, cursor) + character + input.slice(cursor); cursor++; redraw(); }
    }
  }

  onMount(() => {
    terminal = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 12 });
    fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host); fit.fit(); columns = terminal.cols || 80;
    terminal.writeln('\x1b[90m浏览器命令终端 · 每行通过 ExecStream 在 Sandbox 中执行\x1b[0m');
    const inputDisposable = terminal.onData(handleData);
    terminal.attachCustomKeyEventHandler(event => {
      if (running || event.type !== 'keydown') return true;
      if (event.key === 'ArrowUp' && history.length) { if (historyIndex < 0) { savedInput = input; historyIndex = history.length - 1; } else if (historyIndex > 0) historyIndex--; input = history[historyIndex]; cursor = input.length; redraw(); return false; }
      if (event.key === 'ArrowDown' && historyIndex >= 0) { if (historyIndex < history.length - 1) input = history[++historyIndex]; else { historyIndex = -1; input = savedInput; } cursor = input.length; redraw(); return false; }
      if (event.key === 'ArrowLeft') { if (cursor > 0) { cursor--; moveCursor(-1); } return false; }
      if (event.key === 'ArrowRight') { if (cursor < input.length) { cursor++; moveCursor(1); } return false; }
      return true;
    });
    const resize = new ResizeObserver(() => { fit?.fit(); columns = terminal?.cols || 80; }); resize.observe(host);
    void stream('/bin/pwd', [], '').then(value => { if (value.trim()) cwd = value.trim(); }).catch(() => {}).finally(nextPrompt);
    return () => { active?.abort(); resize.disconnect(); inputDisposable.dispose(); terminal?.dispose(); };
  });
</script>

<section class="terminal" aria-label="Sandbox command terminal"><header><strong>Terminal</strong><code>{sandboxId}</code><span>{running ? '执行中…' : '已连接'}</span></header><div class="host" bind:this={host}></div></section>
<style>.terminal{display:flex;flex-direction:column;height:100%;min-height:360px;background:#0d1117;color:#d8dee9}.terminal header{display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #30363d}.terminal code{flex:1;color:#8b949e;overflow:hidden;text-overflow:ellipsis}.terminal span{font-size:var(--font-size-xs);color:#7ee787}.host{flex:1;min-height:0;padding:6px}</style>
