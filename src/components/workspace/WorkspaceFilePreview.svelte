<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import { workspaceFiles } from '../../lib/workspace/store.svelte';
  import { LocalWorkspaceApiError } from '../../lib/workspace/local-api';
  import { formatFileSize } from '../../lib/workspace/tree';

  const PREVIEW_TEXT_LIMIT = 256 * 1024;
  const TEXT_SCAN_BYTES = 4096;

  type PreviewState =
    | { kind: 'empty' }
    | { kind: 'loading' }
    | { kind: 'text'; text: string; truncated: boolean }
    | { kind: 'image'; url: string; isSvg: boolean }
    | { kind: 'binary' }
    | { kind: 'error'; message: string };

  let state = $state<PreviewState>({ kind: 'empty' });
  let loadGeneration = 0;
  let objectUrl: string | null = null;

  const activeEntry = $derived(
    workspaceFiles.files.find((f) => f.path === workspaceFiles.activePath && !f.dir) ?? null,
  );

  $effect(() => {
    const path = workspaceFiles.activePath;
    if (!path) {
      cleanupObjectUrl();
      state = { kind: 'empty' };
      return;
    }
    const generation = ++loadGeneration;
    state = { kind: 'loading' };
    void loadPreview(path, generation);
  });

  function cleanupObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  async function loadPreview(path: string, generation: number) {
    try {
      const blob = await workspaceFiles.download(path);
      if (generation !== loadGeneration) return;
      const nextState = await classifyBlob(blob, path);
      if (generation !== loadGeneration) {
        if (nextState.kind === 'image' && !nextState.isSvg) URL.revokeObjectURL(nextState.url);
        return;
      }
      cleanupObjectUrl();
      if (nextState.kind === 'image' && !nextState.isSvg) {
        objectUrl = nextState.url;
      }
      state = nextState;
    } catch (error) {
      if (generation !== loadGeneration) return;
      const message = error instanceof LocalWorkspaceApiError ? error.message : (error instanceof Error ? error.message : String(error));
      // 404: file was deleted server-side; drop it from the tree so the user doesn't
      // keep clicking a stale entry.
      if (error instanceof LocalWorkspaceApiError && (error.status === 404 || error.status === 400)) {
        store.addToast(message, 'error');
        workspaceFiles.removeFile(path);
        state = { kind: 'empty' };
        return;
      }
      state = { kind: 'error', message };
    }
  }

  function isSvgName(name: string): boolean {
    return /\.svg$/i.test(name);
  }
  function isImageName(name: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(name);
  }
  function isTextName(name: string): boolean {
    return /\.(md|markdown|txt|log|json|ya?ml|sh|bash|py|js|ts|tsx|jsx|go|rs|java|c|cpp|h|hpp|rb|php|sql|html?|css|xml|toml|ini|cfg|conf|env|csv|tsv)$/i.test(name);
  }

  async function classifyBlob(blob: Blob, path: string): Promise<PreviewState> {
    const name = path.split('/').pop() ?? path;

    if (isSvgName(name)) {
      const text = await blob.text();
      try {
        const base64 = btoa(unescape(encodeURIComponent(text)));
        return { kind: 'image', url: `data:image/svg+xml;base64,${base64}`, isSvg: true };
      } catch {
        return { kind: 'text', text, truncated: false };
      }
    }
    if (isImageName(name)) {
      return { kind: 'image', url: URL.createObjectURL(blob), isSvg: false };
    }

    // Scan first 4 KiB for null bytes / control chars to detect binary.
    const scanBuf = new Uint8Array(await blob.slice(0, TEXT_SCAN_BYTES).arrayBuffer());
    let binary = false;
    for (let i = 0; i < scanBuf.length; i++) {
      const b = scanBuf[i];
      if (b === 0) { binary = true; break; }
      if (b < 9 || (b > 13 && b < 32)) { binary = true; break; }
    }
    if (binary && !isTextName(name)) {
      return { kind: 'binary' };
    }

    const truncated = blob.size > PREVIEW_TEXT_LIMIT;
    const sliceBlob = truncated ? blob.slice(0, PREVIEW_TEXT_LIMIT) : blob;
    let text = await sliceBlob.text();
    if (truncated) {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline > 0) text = text.slice(0, lastNewline);
    }
    return { kind: 'text', text, truncated };
  }

  async function downloadActive() {
    if (!activeEntry) return;
    try {
      const blob = await workspaceFiles.download(activeEntry.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = activeEntry.path.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      store.addToast('下载失败：' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  function formatDate(iso: string): string {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return iso;
    }
  }

  function fileName(path: string): string {
    return path.split('/').pop() ?? path;
  }
</script>

<aside class="preview-pane">
  {#if !activeEntry}
    <div class="preview-empty">
      <div class="empty-icon">📄</div>
      <div class="empty-title">未选择文件</div>
      <div class="empty-hint">从左侧文件树选择一个文件预览</div>
    </div>
  {:else}
    <header class="preview-header">
      <span class="filename">{fileName(activeEntry.path)}</span>
      <span class="meta">{formatFileSize(activeEntry.size)} · {formatDate(activeEntry.updated_at)}</span>
      <div class="spacer"></div>
      <button
        type="button"
        class="icon-btn"
        onclick={downloadActive}
        disabled={state.kind === 'loading'}
        title="下载到本地"
      >⬇ 下载</button>
      <button
        type="button"
        class="icon-btn danger"
        disabled
        title="需 daemon 升级"
      >✕ 删除</button>
    </header>

    <div class="preview-body">
      {#if state.kind === 'loading'}
        <div class="state-msg">加载中…</div>
      {:else if state.kind === 'error'}
        <div class="state-msg error">{state.message}</div>
      {:else if state.kind === 'binary'}
        <div class="state-msg">
          <div>二进制文件</div>
          <div class="meta-line">{formatFileSize(activeEntry.size)}</div>
          <div class="meta-hint">不支持预览，可点击"下载"保存到本地</div>
        </div>
      {:else if state.kind === 'image'}
        <div class="image-wrap">
          <img src={state.url} alt={fileName(activeEntry.path)} />
        </div>
      {:else if state.kind === 'text'}
        <pre class="text-content">{state.text}</pre>
        {#if state.truncated}
          <div class="truncate-hint">已截断，仅显示前 256 KiB</div>
        {/if}
      {/if}
    </div>
  {/if}
</aside>

<style>
  .preview-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-primary);
  }
  .preview-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-muted);
    text-align: center;
  }
  .empty-icon { font-size: 32px; opacity: 0.3; }
  .empty-title { font-size: var(--font-size-md); color: var(--text-secondary); font-weight: 600; }
  .empty-hint { font-size: var(--font-size-xs); }

  .preview-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }
  .filename {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
  }
  .meta {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer { flex: 1; }
  .icon-btn {
    padding: 4px 10px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    background: var(--bg-tertiary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--accent-blue);
  }
  .icon-btn.danger:hover:not(:disabled) {
    color: var(--accent-red);
    border-color: var(--accent-red);
  }
  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .preview-body {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .state-msg {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 24px;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    text-align: center;
  }
  .state-msg.error { color: var(--accent-red); }
  .meta-line {
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }
  .meta-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }
  .image-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
  }
  .image-wrap img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .text-content {
    flex: 1;
    margin: 0;
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    line-height: 1.6;
    color: var(--text-secondary);
    background: var(--bg-primary);
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
  }
  .truncate-hint {
    padding: 6px 14px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    text-align: center;
    border-top: 1px solid var(--border-color);
    flex-shrink: 0;
  }
</style>
