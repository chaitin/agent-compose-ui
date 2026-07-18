<script lang="ts">
  import { onMount } from 'svelte';
  import { ExecCommand, ExecRequest, ExecStreamEventType, StdioStream } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { execService } from '../../lib/rpc';
  import { DIRECTORY_LIST_BYTES, FILE_PREVIEW_BYTES, MAX_DIRECTORY_ENTRIES, MAX_WRITABLE_FILE_BYTES, appendLimitedOutput, createLimitedOutput, formatExecError, isAbortError, parseDirectoryListing, writableFileBytes, writeBoundedFile, type FileBrowserEntry } from './file-browser';
  let { sandboxId }: { sandboxId: string } = $props();
  type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';
  let currentPath = $state('/workspace'); let entries: FileBrowserEntry[] = $state([]); let selectedPath = $state(''); let content = $state('');
  let loading = $state(false); let truncated = $state(false); let error = $state(''); let active: AbortController | undefined;
  let saveState: SaveState = $state('idle'); let savedAt = $state('');
  let writeBytes = $derived(writableFileBytes(content));
  function request(command: string, args: string[], maxOutputBytes: number, cwd = '') { return new ExecRequest({ target: { case: 'sandboxId', value: sandboxId }, command: new ExecCommand({ command, args }), cwd, maxOutputBytes, timeoutMs: 30_000 }); }
  async function stream(command: string, args: string[], cap: number, cwd = '') {
    active?.abort(); active = new AbortController(); let stdout = createLimitedOutput(); let stderr = createLimitedOutput(); let resultError = '';
    for await (const event of execService.execStream(request(command, args, cap, cwd), { signal: active.signal })) {
      if (event.eventType === ExecStreamEventType.OUTPUT) { if (event.stream === StdioStream.STDERR) stderr = appendLimitedOutput(stderr, event.chunk, cap); else stdout = appendLimitedOutput(stdout, event.chunk, cap); }
      if (event.result) resultError = event.result.error || '';
    }
    if (resultError || stderr.value) throw new Error(formatExecError(stderr.value, resultError));
    return stdout;
  }
  async function list(path: string) {
    loading = true; error = '';
    try { const output = await stream('/usr/bin/find', [path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\t%f\n'], DIRECTORY_LIST_BYTES); const parsed = parseDirectoryListing(output.value, path); currentPath = path; entries = parsed.slice(0, MAX_DIRECTORY_ENTRIES); truncated = output.truncated || parsed.length > MAX_DIRECTORY_ENTRIES; }
    catch (cause) { if (!isAbortError(cause)) error = cause instanceof Error ? cause.message : String(cause); } finally { loading = false; }
  }
  async function open(entry: FileBrowserEntry) {
    if (entry.isDir) { await list(entry.fullPath); return; } loading = true; error = ''; selectedPath = entry.fullPath; saveState = 'idle'; savedAt = '';
    try { const output = await stream('/bin/cat', ['--', entry.fullPath], FILE_PREVIEW_BYTES); content = output.value; truncated = output.truncated; }
    catch (cause) { if (!isAbortError(cause)) error = cause instanceof Error ? cause.message : String(cause); } finally { loading = false; }
  }
  async function save() {
    if (!selectedPath) return; loading = true; error = ''; saveState = 'saving';
    try { await writeBoundedFile(content, selectedPath, (encoded, path) => stream('/bin/sh', ['-c', 'printf %s "$1" | base64 -d > "$2"', 'file-write', encoded, path], FILE_PREVIEW_BYTES)); saveState = 'saved'; savedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
    catch (cause) { if (!isAbortError(cause)) { error = cause instanceof Error ? cause.message : String(cause); saveState = 'failed'; } } finally { loading = false; }
  }
  function markDirty() { if (!truncated) { saveState = 'dirty'; savedAt = ''; } }
  function saveStatusText() { return writeBytes > MAX_WRITABLE_FILE_BYTES ? '无法保存' : saveState === 'saving' ? '保存中…' : saveState === 'saved' ? `已保存 · ${savedAt}` : saveState === 'failed' ? '保存失败' : saveState === 'dirty' ? '未保存' : ''; }
  function parent() { if (currentPath === '/') return '/'; return currentPath.replace(/\/?[^/]+$/, '') || '/'; }
  onMount(() => { void list(currentPath); return () => active?.abort(); });
</script>
<section class="browser"><header><button onclick={() => list(parent())} disabled={loading || currentPath === '/'}>↑</button><code>{currentPath}</code><button onclick={() => list(currentPath)} disabled={loading}>刷新</button></header>{#if error}<div class="error">{error}</div>{/if}{#if truncated}<div class="warning">输出达到安全上限，仅显示完整的已接收内容。</div>{/if}<div class="body"><nav>{#each entries as entry (entry.fullPath)}<button class:directory={entry.isDir} onclick={() => open(entry)}>{entry.isDir ? '📁' : '📄'} {entry.name}</button>{/each}{#if !loading && entries.length === 0}<p>空目录</p>{/if}</nav><main>{#if selectedPath}<div class="editor-head"><code>{selectedPath}</code><span class:failed={writeBytes > MAX_WRITABLE_FILE_BYTES}>{writeBytes <= MAX_WRITABLE_FILE_BYTES ? `剩余 ${MAX_WRITABLE_FILE_BYTES - writeBytes} bytes` : `超过写入上限 ${writeBytes - MAX_WRITABLE_FILE_BYTES} bytes`}</span>{#if saveStatusText()}<span class:failed={saveState === 'failed' || writeBytes > MAX_WRITABLE_FILE_BYTES} class:saved={saveState === 'saved'}>{saveStatusText()}</span>{/if}<button onclick={save} disabled={loading || truncated || writeBytes > MAX_WRITABLE_FILE_BYTES}>{saveState === 'saving' ? '保存中…' : '保存'}</button></div><textarea bind:value={content} oninput={markDirty} readonly={truncated}></textarea>{:else}<p>选择文件以预览</p>{/if}</main></div></section>
<style>.browser{height:100%;min-height:360px;display:flex;flex-direction:column;background:var(--bg-primary)}header,.editor-head{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border-color)}header code,.editor-head code{flex:1;overflow:hidden;text-overflow:ellipsis}.body{display:grid;grid-template-columns:260px 1fr;flex:1;min-height:0}nav{overflow:auto;border-right:1px solid var(--border-color);padding:6px}nav button{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--text-primary);padding:5px}.directory{font-weight:600}main{display:flex;flex-direction:column;min-width:0}textarea{flex:1;resize:none;border:0;padding:10px;background:var(--bg-secondary);color:var(--text-primary);font-family:monospace}.error,.warning{padding:6px 10px;font-size:var(--font-size-xs)}.error,.failed{color:var(--accent-red)}.warning{color:var(--accent-orange)}.saved{color:var(--accent-green)}button{border:1px solid var(--border-color);background:var(--bg-secondary);color:var(--text-primary);border-radius:4px;padding:5px 8px}</style>
