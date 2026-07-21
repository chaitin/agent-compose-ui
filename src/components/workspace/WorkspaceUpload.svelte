<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import { workspaceFiles } from '../../lib/workspace/store.svelte';
  import { LocalWorkspaceApiError } from '../../lib/workspace/local-api';
  import { formatFileSize } from '../../lib/workspace/tree';
  import { sanitizeTarPath, packTarBlob } from '../../lib/workspace/tar';
  import type { TarEntryInput } from '../../lib/workspace/types';

  // Design doc §4.1: actual limit should come from GET /api/agent-compose/config/workspace (not yet implemented).
  // Until then, use the default 1 GiB. Backend will still enforce its own limit and 413 if smaller.
  const DEFAULT_UPLOAD_LIMIT_BYTES = 1 << 30;

  type OverwritePrompt =
    | null
    | { kind: 'single'; file: File; path: string }
    | { kind: 'tar'; file: File }
    | { kind: 'archive-overwrite'; entries: TarEntryInput[]; totalBytes: number; existing: string[] };

  let fileInput = $state<HTMLInputElement | undefined>(undefined);
  let folderInput = $state<HTMLInputElement | undefined>(undefined);
  let uploading = $state(false);
  let progress = $state<{ loaded: number; total: number; phase?: string } | null>(null);
  let prompt = $state<OverwritePrompt>(null);

  function openPicker() {
    if (uploading) return;
    fileInput?.click();
  }

  function openFolderPicker() {
    if (uploading) return;
    folderInput?.click();
  }

  function onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length > 0) void handleSelectedFiles(files);
  }

  async function handleSelectedFiles(files: File[]) {
    if (uploading) return;
    if (files.length === 1) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.tar')) {
        const archiveType = await detectArchiveType(file);
        if (archiveType !== 'tar') {
          const hint = archiveType === 'unknown'
            ? '文件不是有效的 tar 归档，请检查文件格式'
            : `文件实际是 ${archiveType} 压缩格式，请先解压再上传`;
          store.addToast(hint, 'error');
          return;
        }
        prompt = { kind: 'tar', file };
        return;
      }
      await startSingleUpload(file);
      return;
    }
    await startArchiveUpload(files.map((file) => fileToTarEntry(file)));
  }

  // Sniff the first few bytes to distinguish a real (uncompressed) tar from
  // .tar.gz / .tar.bz2 / .tar.xz / .zip files that were renamed to .tar.
  // The backend's archive/tar rejects these with "invalid tar header", which
  // is opaque to users - catch the common cases here with a clear message.
  async function detectArchiveType(
    file: File,
  ): Promise<'tar' | 'gzip' | 'bzip2' | 'xz' | 'zip' | 'unknown'> {
    try {
      const head = new Uint8Array(await file.slice(0, 6).arrayBuffer());
      if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
      if (head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) return 'bzip2';
      if (head[0] === 0xfd && head[1] === 0x37 && head[2] === 0x7a && head[3] === 0x58 && head[4] === 0x5a) return 'xz';
      if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';
      // USTAR magic at offset 257. Reading 263 bytes covers it.
      const ustar = new Uint8Array(await file.slice(257, 263).arrayBuffer());
      if (ustar[0] === 0x75 && ustar[1] === 0x73 && ustar[2] === 0x74 && ustar[3] === 0x61 && ustar[4] === 0x72) {
        return 'tar';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function fileToTarEntry(file: File): TarEntryInput {
    const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const path = relPath && relPath.length > 0 ? relPath : file.name;
    return {
      path,
      file,
      mtime: Math.floor(file.lastModified / 1000),
    };
  }

  async function startSingleUpload(file: File) {
    if (uploading) return;
    if (file.size > DEFAULT_UPLOAD_LIMIT_BYTES) {
      store.addToast(`文件超过 ${formatFileSize(DEFAULT_UPLOAD_LIMIT_BYTES)} 限制`, 'error');
      return;
    }
    const target = file.name;
    if (workspaceFiles.hasFile(target)) {
      prompt = { kind: 'single', file, path: target };
      return;
    }
    await performSingleUpload(file, target);
  }

  async function startArchiveUpload(entries: TarEntryInput[]) {
    if (uploading || entries.length === 0) return;
    const sanitizedEntries: TarEntryInput[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const sanitized = sanitizeTarPath(entry.path);
      if (!sanitized) {
        store.addToast(`跳过非法路径：${entry.path}`, 'error');
        continue;
      }
      sanitizedEntries.push({ ...entry, path: sanitized });
      totalBytes += entry.file.size;
    }
    if (sanitizedEntries.length === 0) {
      store.addToast('没有可上传的有效文件', 'error');
      return;
    }
    if (totalBytes > DEFAULT_UPLOAD_LIMIT_BYTES) {
      store.addToast(
        `总大小 ${formatFileSize(totalBytes)} 超过 ${formatFileSize(DEFAULT_UPLOAD_LIMIT_BYTES)} 限制`,
        'error',
      );
      return;
    }
    // Check overwrite: any sanitized path that already exists as a file.
    const existing = sanitizedEntries
      .map((e) => e.path)
      .filter((p) => workspaceFiles.hasFile(p));
    if (existing.length > 0) {
      prompt = { kind: 'archive-overwrite', entries: sanitizedEntries, totalBytes, existing };
      return;
    }
    await performArchiveUpload(sanitizedEntries, totalBytes);
  }

  function confirmPrompt() {
    if (!prompt) return;
    const current = prompt;
    prompt = null;
    if (current.kind === 'single') {
      void performSingleUpload(current.file, current.path);
    } else if (current.kind === 'tar') {
      // Send the existing .tar as-is via XHR + FormData. The backend extracts
      // its contents. Do NOT wrap it in another tar - that would store the .tar
      // as a single file instead of extracting it.
      void performTarExtractUpload(current.file);
    } else if (current.kind === 'archive-overwrite') {
      void performArchiveUpload(current.entries, current.totalBytes);
    }
  }

  function cancelPrompt() {
    prompt = null;
  }

  function pickAsFile() {
    if (!prompt || prompt.kind !== 'tar') return;
    const file = prompt.file;
    prompt = null;
    void startSingleUpload(file);
  }

  async function performSingleUpload(file: File, targetPath: string) {
    uploading = true;
    progress = { loaded: 0, total: file.size, phase: 'uploading' };
    try {
      await workspaceFiles.upload(file, targetPath, (p) => (progress = { ...p, phase: 'uploading' }));
      store.addToast(`已上传 ${targetPath}`, 'success');
    } catch (error) {
      handleUploadError(error);
    } finally {
      uploading = false;
      progress = null;
    }
  }

  async function performTarExtractUpload(file: File) {
    uploading = true;
    progress = { loaded: 0, total: file.size, phase: 'uploading' };
    try {
      await workspaceFiles.upload(file, undefined, (p) => (progress = { ...p, phase: 'uploading' }));
      store.addToast(`已上传 ${file.name}`, 'success');
    } catch (error) {
      handleUploadError(error);
    } finally {
      uploading = false;
      progress = null;
    }
  }

  async function performArchiveUpload(entries: TarEntryInput[], totalBytes: number) {
    uploading = true;
    progress = { loaded: 0, total: totalBytes, phase: 'packing' };
    try {
      const tarBlob = packTarBlob(entries);
      const tarFile = new File([tarBlob], 'upload.tar', { type: 'application/x-tar' });
      await workspaceFiles.upload(tarFile, undefined, (p) => {
        progress = { loaded: p.loaded, total: totalBytes, phase: 'uploading' };
      });
      store.addToast(`已上传 ${entries.length} 个文件`, 'success');
    } catch (error) {
      handleUploadError(error);
    } finally {
      uploading = false;
      progress = null;
    }
  }

  function handleUploadError(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      store.addToast('上传已取消', 'info');
    } else if (error instanceof LocalWorkspaceApiError && error.status === 413) {
      store.addToast('文件超过上传限制', 'error');
    } else {
      store.addToast('上传失败：' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  function progressPercent(): number {
    if (!progress || progress.total === 0) return 0;
    return Math.min(100, Math.round((progress.loaded / progress.total) * 100));
  }

  function progressLabel(): string {
    if (!progress) return '';
    if (progress.phase === 'packing') return `打包中 ${progressPercent()}%`;
    if (progress.phase === 'uploading') return `上传中 ${progressPercent()}%`;
    return '';
  }
</script>

<div class="upload-bar" class:uploading>
  <input
    type="file"
    multiple
    bind:this={fileInput}
    onchange={onFileChange}
    style="display:none"
    aria-hidden="true"
    tabindex="-1"
  />
  <input
    type="file"
    multiple
    webkitdirectory
    bind:this={folderInput}
    onchange={onFileChange}
    style="display:none"
    aria-hidden="true"
    tabindex="-1"
  />
  {#if uploading && progress}
    <div class="upload-progress">
      <div class="progress-label">{progressLabel()}</div>
      <div class="progress-bar"><div class="progress-fill" style="width:{progressPercent()}%"></div></div>
    </div>
  {:else}
    <button
      type="button"
      class="upload-btn primary"
      onclick={openPicker}
      disabled={uploading}
    >
      <span class="btn-icon" aria-hidden="true">📄</span>
      <span class="btn-label">上传文件</span>
    </button>
    <button
      type="button"
      class="upload-btn"
      onclick={openFolderPicker}
      disabled={uploading}
    >
      <span class="btn-icon" aria-hidden="true">📁</span>
      <span class="btn-label">上传文件夹</span>
    </button>
  {/if}
</div>

{#if prompt}
  <div class="confirm-overlay" role="dialog" aria-modal="true">
    <div class="confirm-dialog">
      {#if prompt.kind === 'single'}
        <div class="confirm-title">文件已存在</div>
        <div class="confirm-desc">
          <code>{prompt.path}</code> 已存在于 workspace，是否覆盖？
        </div>
        <div class="confirm-actions">
          <button type="button" onclick={cancelPrompt} disabled={uploading}>取消</button>
          <button type="button" class="primary" onclick={confirmPrompt} disabled={uploading}>覆盖</button>
        </div>
      {:else if prompt.kind === 'tar'}
        <div class="confirm-title">检测到 .tar 文件</div>
        <div class="confirm-desc">
          <code>{prompt.file.name}</code> 是 tar 归档。要作为普通文件存储，还是解压到 workspace 根目录？
        </div>
        <div class="confirm-actions">
          <button type="button" onclick={cancelPrompt} disabled={uploading}>取消</button>
          <button type="button" onclick={pickAsFile} disabled={uploading}>作为文件存储</button>
          <button type="button" class="primary" onclick={confirmPrompt} disabled={uploading}>解压到 workspace</button>
        </div>
      {:else if prompt.kind === 'archive-overwrite'}
        <div class="confirm-title">将覆盖 {prompt.existing.length} 个文件</div>
        <div class="confirm-desc">
          以下文件已存在，归档解压将覆盖它们：
          <ul class="overwrite-list">
            {#each prompt.existing.slice(0, 6) as p}
              <li><code>{p}</code></li>
            {/each}
            {#if prompt.existing.length > 6}
              <li class="more">…还有 {prompt.existing.length - 6} 个</li>
            {/if}
          </ul>
        </div>
        <div class="confirm-actions">
          <button type="button" onclick={cancelPrompt} disabled={uploading}>取消</button>
          <button type="button" class="primary" onclick={confirmPrompt} disabled={uploading}>覆盖</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .upload-bar {
    display: flex;
    gap: 8px;
    margin: 8px 14px;
    flex-shrink: 0;
    align-items: stretch;
  }
  .upload-bar.uploading {
    flex-direction: column;
  }
  .upload-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .upload-btn:hover:not(:disabled) {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  }
  .upload-btn:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: 1px;
  }
  .upload-btn.primary {
    background: var(--accent-blue);
    border-color: var(--accent-blue);
    color: #0d1117;
    font-weight: 600;
  }
  .upload-btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-blue) 88%, white);
    border-color: color-mix(in srgb, var(--accent-blue) 88%, white);
    color: #0d1117;
  }
  .upload-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-icon {
    font-size: 14px;
    line-height: 1;
  }
  .upload-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
    width: 100%;
  }
  .progress-label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }
  .progress-bar {
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent-blue);
    transition: width 0.15s;
  }
  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .confirm-dialog {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 16px;
    width: min(420px, 90vw);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .confirm-title {
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--text-primary);
  }
  .confirm-desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .confirm-desc code {
    font-family: var(--font-mono);
    color: var(--accent-blue);
  }
  .overwrite-list {
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    max-height: 120px;
    overflow-y: auto;
  }
  .overwrite-list li code {
    color: var(--text-secondary);
  }
  .overwrite-list .more {
    color: var(--text-muted);
    list-style: none;
    margin-left: -18px;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .confirm-actions button {
    padding: 6px 12px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .confirm-actions button.primary {
    background: var(--accent-blue);
    color: #0d1117;
    border-color: var(--accent-blue);
    font-weight: 600;
  }
  .confirm-actions button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
