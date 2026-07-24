<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { EnvVarUpdateSpec, GetGlobalEnvRequest, UpdateGlobalEnvRequest } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { settingsService } from '../../lib/rpc';

  interface Draft { name: string; value: string; secret: boolean; }
  interface Props { agentName: string; names: string[]; onSaved: (names: string[]) => void; onCancel: () => void; }
  let { agentName, names, onSaved, onCancel }: Props = $props();
  let dialog = $state<HTMLDialogElement>();
  let firstValueInput = $state<HTMLInputElement>();
  let drafts = $state<Draft[]>([]);
  let error = $state('');
  let saving = $state(false);

  onMount(async () => {
    drafts = names.map((name) => ({ name, value: '', secret: /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name) }));
    await tick();
    if (typeof dialog?.showModal === 'function') dialog.showModal();
    else dialog?.setAttribute('open', '');
    firstValueInput?.focus();
  });

  async function save() {
    if (drafts.some((draft) => !draft.value)) { error = '请填写全部变量值'; return; }
    saving = true;
    error = '';
    try {
      // UpdateGlobalEnv replaces the full collection. Re-read immediately before
      // saving and merge into that snapshot so this shortcut preserves newer rows.
      const latest = (await settingsService.getGlobalEnv(new GetGlobalEnvRequest())).env;
      const existing = new Set(latest.map((item) => item.name));
      const additions = drafts.filter((draft) => !existing.has(draft.name));
      if (additions.length) {
        const env = latest.map((item) => new EnvVarUpdateSpec({
          name: item.name, secret: item.secret, value: item.secret ? undefined : item.value,
        }));
        env.push(...additions.map((item) => new EnvVarUpdateSpec(item)));
        await settingsService.updateGlobalEnv(new UpdateGlobalEnvRequest({ env }));
      }
      onSaved(drafts.map((item) => item.name));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally { saving = false; }
  }
</script>

<dialog bind:this={dialog} aria-label="配置全局环境变量" oncancel={(event) => { event.preventDefault(); if (!saving) onCancel(); }}>
  <header><div><h3>配置全局环境变量</h3><p>Agent “{agentName}” 引用了以下尚未配置的变量。</p></div><button aria-label="关闭" onclick={onCancel} disabled={saving}>×</button></header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="rows">
    {#each drafts as draft, index (draft.name)}
      <div class="row">
        <label><span>变量名称</span><input aria-label={`变量名称 ${index + 1}`} value={draft.name} readonly /></label>
        <label><span>变量值</span>{#if index === 0}<input bind:this={firstValueInput} aria-label={`变量值 ${index + 1}`} type={draft.secret ? 'password' : 'text'} bind:value={draft.value} />{:else}<input aria-label={`变量值 ${index + 1}`} type={draft.secret ? 'password' : 'text'} bind:value={draft.value} />{/if}</label>
        <label class="secret"><input aria-label={`敏感变量 ${index + 1}`} type="checkbox" bind:checked={draft.secret} /><span>敏感变量</span></label>
      </div>
    {/each}
  </div>
  <footer><button onclick={onCancel} disabled={saving}>取消</button><button class="primary" onclick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button></footer>
</dialog>

<style>
  dialog{position:fixed;inset:0;z-index:30;box-sizing:border-box;width:min(760px,calc(100% - 32px));max-height:calc(100% - 48px);margin:auto;overflow:auto;padding:18px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary);color:var(--text-primary);box-shadow:0 18px 50px #0008}header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px}h3{margin:0;font-size:var(--font-size-xl)}p{margin:5px 0 0;color:var(--text-secondary)}button,input{box-sizing:border-box;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-primary);color:var(--text-primary);padding:7px 10px}.rows{display:grid;gap:12px;margin:18px 0}.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) auto;align-items:end;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--border-color)}label{display:grid;min-width:0;gap:6px;font-size:var(--font-size-md)}label input{width:100%;min-width:0}.secret{display:flex;align-items:center;padding-bottom:8px}.secret input{width:auto}.error{color:var(--accent-red)}footer{justify-content:flex-end}.primary{border-color:var(--accent-blue);background:var(--accent-blue);color:#fff}@media(max-width:650px){.row{grid-template-columns:minmax(0,1fr)}.secret{padding-bottom:0}}
</style>
