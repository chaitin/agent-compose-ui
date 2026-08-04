<script lang="ts">
  import { volumeFileApi, VolumeFileApiError, type VolumeFileEntry, type VolumePreview } from '../../lib/volume-files/api';
  import VolumeFolderCreateModal from './VolumeFolderCreateModal.svelte';
  interface Props { projectKey: string; volume: string }
  type Availability = 'pending' | 'ready' | 'unavailable' | 'missing';
  let { projectKey, volume }: Props = $props();
  let path = $state(''); let entries = $state<VolumeFileEntry[]>([]); let preview = $state<VolumePreview | null>(null);
  let loading = $state(false); let error = $state(''); let folderName = $state(''); let deletion = $state<VolumeFileEntry | null>(null);
  let folderDialog = $state(false); let uploadInput: HTMLInputElement;
  let draft = $state(''); let saving = $state(false); let conflict = $state(false); let mutationBusy = $state(false);
  let availability = $state<Availability>('pending');
  const dirty = $derived(!!preview && draft !== preview.content);
  const volumeUnavailable = $derived(availability !== 'ready');
  const mutationsDisabled = $derived(mutationBusy || dirty || volumeUnavailable);
  let generation = 0; let controller: AbortController | null = null; let identity = ''; const mutationControllers = new Set<AbortController>();
  const join = (base: string, name: string) => base ? `${base}/${name}` : name;
  function message(value: unknown) { if (value instanceof VolumeFileApiError && value.status === 409) return '文件已发生冲突，请重新加载后重试'; return value instanceof Error ? value.message : String(value); }
  function listFailure(value: unknown): { availability: Availability; message: string } {
    if (value instanceof VolumeFileApiError && value.status === 503 && value.code === 'unavailable') return { availability: 'unavailable', message: '卷文件服务未配置，配置后请刷新页面。' };
    if (value instanceof VolumeFileApiError && value.status === 404 && value.code === 'not_found') return { availability: 'missing', message: '实体卷尚未创建。请点击上方“应用 YAML”；成功后会自动加载。' };
    return { availability: 'pending', message: message(value) };
  }
  function active(token: number, key: string, vol: string) { return token === generation && key === projectKey && vol === volume; }
  async function load(nextPath = path) {
    const token = ++generation; const key = projectKey; const vol = volume; controller?.abort(); controller = new AbortController(); loading = true; availability = 'pending'; error = ''; entries = []; preview = null; draft = ''; conflict = false; saving = false;
    try { const value = await volumeFileApi.list(key, vol, nextPath, controller.signal); if (active(token, key, vol)) { path = nextPath; entries = value; availability = 'ready'; } }
    catch (value) { if (active(token, key, vol) && !(value instanceof DOMException && value.name === 'AbortError')) { const failure = listFailure(value); availability = failure.availability; error = failure.message; } }
    finally { if (active(token, key, vol)) loading = false; }
  }
  async function open(entry: VolumeFileEntry) {
    if (mutationBusy || !confirmDiscard()) return;
    if (entry.dir) { await load(entry.path); return; } const token = ++generation; const key = projectKey; const vol = volume; controller?.abort(); controller = new AbortController(); error = '';
    try { const value = await volumeFileApi.preview(key, vol, entry.path, controller.signal); if (active(token, key, vol)) { preview = value; draft = value.content; conflict = false; } }
    catch (value) { if (active(token, key, vol) && !(value instanceof DOMException && value.name === 'AbortError')) error = message(value); }
  }
  async function mutate(operation: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> {
    if (mutationBusy || volumeUnavailable) { if (mutationBusy) error = '已有文件操作正在进行，请等待完成'; return false; }
    mutationBusy = true;
    const token = ++generation; const key = projectKey; const vol = volume; const at = path; controller?.abort(); controller = null; const mutation = new AbortController(); mutationControllers.add(mutation); error = '';
    try { await operation(mutation.signal); if (!active(token, key, vol)) return false; mutationBusy = false; await load(at); return true; }
    catch (value) { if (active(token, key, vol) && !(value instanceof DOMException && value.name === 'AbortError')) error = message(value); return false; }
    finally { mutationControllers.delete(mutation); if (active(token, key, vol)) mutationBusy = false; }
  }
  async function createFolder(name: string) { folderName = name; if (await mutate((signal) => volumeFileApi.mkdir(projectKey, volume, join(path, name), signal))) { folderName = ''; folderDialog = false; } }
  async function upload(event: Event) { const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0]; if (!file) return; try { await mutate((signal) => volumeFileApi.upload(projectKey, volume, join(path, file.name), file, signal)); } finally { input.value = ''; } }
  async function save() {
    if (!preview || preview.truncated || saving || mutationBusy) return;
    const original = preview; const content = draft; const token = ++generation; const key = projectKey; const vol = volume;
    controller?.abort(); controller = null; const mutation = new AbortController(); mutationControllers.add(mutation); saving = true; mutationBusy = true; error = ''; conflict = false;
    try {
      await volumeFileApi.write(key, vol, original.path, content, original.sha256, mutation.signal);
      if (!active(token, key, vol)) return;
      const fresh = await volumeFileApi.preview(key, vol, original.path, mutation.signal);
      if (active(token, key, vol)) { preview = fresh; draft = fresh.content; }
    } catch (value) {
      if (!active(token, key, vol) || value instanceof DOMException && value.name === 'AbortError') return;
      if (value instanceof VolumeFileApiError && value.status === 409) { conflict = true; error = '保存冲突：磁盘内容已变化，本地草稿已保留。'; }
      else error = `保存失败：${message(value)}`;
    } finally { mutationControllers.delete(mutation); if (active(token, key, vol)) { saving = false; mutationBusy = false; } }
  }
  async function reloadPreview() { if (!preview) return; await open({ name: preview.path.split('/').at(-1) ?? preview.path, path: preview.path, dir: false, size: 0, mtimeMs: 0 }); }
  function confirmDiscard() { return !preview || draft === preview.content || window.confirm('当前文件有未保存更改，确定放弃吗？'); }
  function requestLoad(nextPath: string) { if (!mutationBusy && confirmDiscard()) void load(nextPath); }
  function confirmDelete() { const item = deletion; deletion = null; if (!item) return; void mutate((signal) => item.dir ? volumeFileApi.removeFolder(projectKey, volume, item.path, true, signal) : volumeFileApi.removeFile(projectKey, volume, item.path, signal)); }
  $effect(() => { const next = `${projectKey}\0${volume}`; if (next === identity) return; identity = next; for (const request of mutationControllers) request.abort(); path = ''; entries = []; preview = null; draft = ''; conflict = false; saving = false; mutationBusy = false; availability = 'pending'; deletion = null; folderDialog = false; folderName = ''; void load(''); return () => { controller?.abort(); for (const request of mutationControllers) request.abort(); }; });
</script>

<section class="browser" aria-label={`卷文件 ${volume}`}>
  <header class="toolbar" role="toolbar" aria-label="卷文件操作">
    <strong>文件 · {volume}</strong>
    <div class="toolbar-actions">
      <button class="ui-button ghost icon-action" type="button" disabled={mutationsDisabled} aria-label="新建文件夹" title="新建文件夹" onclick={() => { folderDialog = true; }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10.5h-17z"/><path d="M15.5 11.5v5M13 14h5"/></svg>
      </button>
      <button class="ui-button ghost icon-action" type="button" disabled={mutationsDisabled} aria-label="上传文件" title="上传文件" onclick={() => uploadInput?.click()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 14v5h14v-5"/></svg>
      </button>
      <input bind:this={uploadInput} class="visually-hidden-file" disabled={mutationsDisabled} type="file" aria-label="选择上传文件" onchange={upload} />
    </div>
  </header>
  {#if error}<p role="alert">{error}</p>{/if}{#if loading}<p role="status">正在加载…</p>{/if}
  <div class="panes">
    <nav class="files" aria-label="卷文件列表"><div class="path"><button class="ui-button ghost" type="button" disabled={!path || mutationBusy || volumeUnavailable} onclick={() => requestLoad(path.split('/').slice(0,-1).join('/'))}>上一级</button><code>{path || '/'}</code></div>{#if !loading && availability === 'ready' && entries.length === 0}<p>目录为空</p>{/if}<ul>{#each entries as item}<li><button class="ui-button ghost" type="button" disabled={mutationBusy || volumeUnavailable} onclick={() => open(item)}>{item.name}</button><button class="ui-button danger icon-action" type="button" disabled={mutationsDisabled} aria-label={`删除 ${item.name}`} title={`删除 ${item.name}`} onclick={() => deletion = item}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button></li>{/each}</ul></nav>
    <section class="preview" aria-label="卷文件预览">{#if preview}<h4>{preview.path}</h4><textarea disabled={saving || volumeUnavailable} readonly={preview.truncated} aria-label="文件内容" bind:value={draft}></textarea>{#if preview.truncated}<p>仅显示部分内容，不能直接保存</p>{:else}<button class="ui-button primary" type="button" disabled={mutationBusy || volumeUnavailable || draft === preview.content} onclick={save}>{saving ? '正在保存…' : '保存文件'}</button>{#if conflict}<button class="ui-button secondary" type="button" disabled={mutationBusy || volumeUnavailable} onclick={reloadPreview}>重新加载文件</button>{/if}{/if}<a href={volumeFileApi.downloadURL(projectKey, volume, preview.path)}>下载</a>{:else}<p>请选择文件预览或编辑。</p>{/if}</section>
  </div>
</section>
{#if folderDialog}<VolumeFolderCreateModal value={folderName} busy={mutationBusy} onValue={(value) => { folderName = value; }} onSubmit={(name) => { void createFolder(name); }} onClose={() => { if (!mutationBusy) folderDialog = false; }} />{/if}
{#if deletion}<div class="backdrop"><div role="dialog" aria-modal="true" aria-label="确认删除"><p>确认删除 {deletion.path}？{deletion.dir ? '文件夹将递归删除。' : ''}</p><button class="ui-button ghost" type="button" onclick={() => deletion = null}>取消</button><button class="ui-button danger" type="button" onclick={confirmDelete}>确认删除</button></div></div>{/if}

<style>
  .browser{border-top:1px solid var(--border-color);display:grid;grid-template-rows:auto auto 1fr;width:100%;min-height:280px}
  .toolbar{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--border-color);flex-wrap:nowrap;min-width:0}
  .toolbar strong{margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .toolbar-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
  .icon-action{display:grid;place-items:center;width:32px;height:32px;padding:0;border-radius:5px}
  .icon-action svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
  .visually-hidden-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .panes{display:grid;grid-template-columns:minmax(200px,32%) 1fr;min-height:0}
  .files{padding:8px;border-right:1px solid var(--border-color);overflow:auto}
  .path,li{display:flex;gap:8px;align-items:center}.path{padding-bottom:8px}
  .preview{padding:10px;min-width:0;overflow:auto}ul{margin:0;padding:0;list-style:none}li{padding:4px 0}li>button:first-child{text-align:left;flex:1}textarea{width:100%;min-height:160px}
  .backdrop{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:110}.backdrop>div{background:var(--bg-primary);padding:20px;border:1px solid var(--border-color)}
</style>
