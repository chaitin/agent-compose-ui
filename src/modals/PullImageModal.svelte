<script lang="ts">
  import { imageService } from '../lib/rpc';
  import { store } from '../lib/stores.svelte';
  import { ImageOperationStatus, ImagePlatform, ImageStoreKind, PullImageRequest, type PullImageResponse } from '../gen/agentcompose/v2/agentcompose_pb';

  let { onclose, oncomplete }: { onclose: () => void; oncomplete: () => void } = $props();
  let imageRef = $state('');
  let storeKind: ImageStoreKind = $state(ImageStoreKind.DOCKER_DAEMON);
  let os = $state(''); let architecture = $state(''); let variant = $state('');
  let running = $state(false); let error = $state(''); let response: PullImageResponse | undefined = $state();

  async function submit() {
    if (!imageRef.trim() || running) { error = '请输入镜像引用'; return; }
    running = true; error = ''; response = undefined;
    try {
      const platform = os.trim() || architecture.trim() || variant.trim()
        ? new ImagePlatform({ os: os.trim(), architecture: architecture.trim(), variant: variant.trim() }) : undefined;
      response = await imageService.pullImage(new PullImageRequest({ imageRef: imageRef.trim(), store: storeKind, platform }));
      store.addToast(response.status === ImageOperationStatus.SUCCEEDED ? '镜像拉取完成' : '镜像拉取请求已返回', response.status === ImageOperationStatus.FAILED ? 'error' : 'success');
      oncomplete();
    } catch (cause: any) { error = cause?.message || '拉取镜像失败'; }
    finally { running = false; }
  }
</script>

<div class="overlay" role="presentation"></div><div class="modal" role="dialog" aria-modal="true" aria-label="拉取镜像">
  <header><div><span>当前请求</span><h2>拉取镜像</h2></div><button onclick={onclose} disabled={running}>×</button></header>
  <div class="body">
    <label>镜像引用<input bind:value={imageRef} placeholder="例如 node:22-alpine" disabled={running}/></label>
    <label>存储<select bind:value={storeKind} disabled={running}><option value={ImageStoreKind.DOCKER_DAEMON}>Docker daemon</option><option value={ImageStoreKind.OCI_CACHE}>OCI 缓存</option></select></label>
    <fieldset><legend>可选平台</legend><input bind:value={os} placeholder="OS，例如 linux" disabled={running}/><input bind:value={architecture} placeholder="架构，例如 amd64" disabled={running}/><input bind:value={variant} placeholder="Variant" disabled={running}/></fieldset>
    {#if error}<div class="error">{error}</div>{/if}
    {#if response}<div class="result"><strong>解析引用：{response.resolvedRef || '后端未提供'}</strong>{#each response.progress as item}<div class="line"><code>{item.id || '-'}</code><span>{item.status} {item.progress}</span></div>{/each}{#each response.warnings as warning}<div class="warning">{warning}</div>{/each}</div>{/if}
  </div>
  <footer><button onclick={onclose} disabled={running}>关闭</button><button class="primary" onclick={submit} disabled={running}>{running ? '拉取中…' : '开始拉取'}</button></footer>
</div>

<style>
  .overlay{position:fixed;inset:0;background:#0009;z-index:100}.modal{position:fixed;z-index:101;top:50%;left:50%;transform:translate(-50%,-50%);width:min(560px,90vw);max-height:86vh;overflow:auto;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-secondary)}header,footer{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border-color)}footer{border:0;border-top:1px solid var(--border-color);justify-content:flex-end;gap:8px}.body{padding:14px;display:grid;gap:12px}h2{font-size:var(--font-size-xl);margin:2px 0}header span{font:var(--font-size-xs) var(--font-mono);color:var(--accent-blue)}label{display:grid;gap:5px;font-size:var(--font-size-xs)}input,select,button{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);padding:7px;font-size:var(--font-size-sm)}fieldset{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;border:1px solid var(--border-color)}legend{font-size:var(--font-size-xs)}.primary{background:var(--accent-blue);color:white}.error,.warning{color:var(--accent-red);font-size:var(--font-size-xs)}.result{display:grid;gap:6px;border:1px solid var(--border-color);padding:9px;font-size:var(--font-size-xs)}.line{display:flex;justify-content:space-between;gap:8px}
</style>
