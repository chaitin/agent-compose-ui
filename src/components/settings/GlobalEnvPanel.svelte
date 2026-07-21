<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { EnvVarUpdateSpec, GetGlobalEnvRequest, UpdateGlobalEnvRequest, type EnvVarSpec } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { settingsService } from '../../lib/rpc';

  type EnvDraft = {
    id: string;
    name: string;
    value: string;
    secret: boolean;
    persisted: boolean;
    storedSecret: boolean;
  };

  let rows = $state<EnvDraft[]>([]);
  let editorRows = $state<EnvDraft[]>([]);
  let dialogOpen = $state(false);
  let error = $state('');
  let editorError = $state('');
  let saving = $state(false);
  let nextId = 0;
  let dialog = $state<HTMLDialogElement>();
  let firstNameInput = $state<HTMLInputElement>();
  let addButton = $state<HTMLButtonElement>();
  let modifyButton = $state<HTMLButtonElement>();

  const message = (value: unknown) => value instanceof Error ? value.message : String(value);
  const nextDraftId = () => `new-${++nextId}`;

  function mapRows(env: EnvVarSpec[]) {
    return env.map((spec) => ({
      id: spec.name,
      name: spec.name,
      value: spec.secret ? '' : spec.value,
      secret: spec.secret,
      persisted: true,
      storedSecret: spec.secret,
    }));
  }

  async function load() {
    error = '';
    try {
      rows = mapRows((await settingsService.getGlobalEnv(new GetGlobalEnvRequest())).env);
    } catch (cause) {
      error = message(cause);
    }
  }

  async function openEditor() {
    editorRows = rows.map((row) => ({ ...row }));
    editorError = '';
    dialogOpen = true;
    await tick();
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    (firstNameInput ?? addButton)?.focus();
  }

  async function closeEditor() {
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    editorRows = [];
    editorError = '';
    dialogOpen = false;
    await tick();
    modifyButton?.focus();
  }

  function cancelEditor(event?: Event) {
    event?.preventDefault();
    void closeEditor();
  }

  function addEditorRow() {
    editorRows = [...editorRows, {
      id: nextDraftId(), name: '', value: '', secret: false,
      persisted: false, storedSecret: false,
    }];
  }

  function validate() {
    const names = new Set<string>();
    for (const row of editorRows) {
      const name = row.name.trim();
      if (!name) return '变量名称不能为空';
      if (names.has(name)) return '变量名称不能重复';
      names.add(name);
      const canRetainStoredSecret = row.persisted
        && row.storedSecret
        && row.secret
        && name === row.id;
      if (!row.value && !canRetainStoredSecret) return '变量值不能为空';
    }
    return '';
  }

  async function save() {
    editorError = validate();
    if (editorError) return;
    saving = true;
    try {
      const env = editorRows.map((row) => {
        const name = row.name.trim();
        const retainsStoredSecret = row.secret
          && row.persisted
          && row.storedSecret
          && name === row.id
          && !row.value;
        return new EnvVarUpdateSpec({
          name,
          secret: row.secret,
          value: retainsStoredSecret ? undefined : row.value,
        });
      });
      rows = mapRows((await settingsService.updateGlobalEnv(new UpdateGlobalEnvRequest({ env }))).env);
      await closeEditor();
    } catch (cause) {
      editorError = message(cause);
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<section class="panel" aria-labelledby="env-title">
  <header>
    <div>
      <h2 id="env-title">全局环境变量</h2>
      <p class="hint">保存后，相关项目会标记为待同步；下次手动保存或启用项目时生效，不会自动运行或改变定时任务。</p>
    </div>
    <button bind:this={modifyButton} onclick={openEditor}>修改变量</button>
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="rows">
    {#each rows as row (row.id)}
      <div class="row">
        <span class="name">{row.name}{#if row.secret}<em>SECRET</em>{/if}</span>
        <code class="value">{row.secret ? '••••••••' : (row.value || '—')}</code>
      </div>
    {:else}
      <p class="empty">尚无全局环境变量。</p>
    {/each}
  </div>
</section>

{#if dialogOpen}
  <dialog class="viewport-modal" bind:this={dialog} aria-label="环境变量" oncancel={cancelEditor}>
    <header class="dialog-title">
      <h3>修改环境变量</h3>
      <button class="close-button" aria-label="取消本次编辑" onclick={() => cancelEditor()}>×</button>
    </header>
    <div class="dialog-content" data-testid="environment-editor-content">
      {#if editorError}<p class="error" role="alert">{editorError}</p>{/if}
      <div class="editor-rows">
        {#each editorRows as row, index (row.id)}
          <div class="editor-row">
          <label>
            <span>变量名称 {index + 1}</span>
            {#if index === 0}
              <input bind:this={firstNameInput} aria-label={`变量名称 ${index + 1}`} bind:value={row.name} />
            {:else}
              <input aria-label={`变量名称 ${index + 1}`} bind:value={row.name} />
            {/if}
          </label>
          <label>
            <span>变量值 {index + 1}</span>
            <input aria-label={`变量值 ${index + 1}`} type={row.secret ? 'password' : 'text'} bind:value={row.value} placeholder={row.storedSecret ? '留空以保留现有密钥' : ''} />
          </label>
          <label class="checkbox">
            <input aria-label={`敏感变量 ${index + 1}`} type="checkbox" bind:checked={row.secret} />
            <span>敏感变量</span>
          </label>
          <button aria-label={`删除变量 ${index + 1}`} onclick={() => editorRows = editorRows.filter((candidate) => candidate.id !== row.id)}>删除</button>
          </div>
        {/each}
      </div>
      <button class="add-button" bind:this={addButton} aria-label="新增变量" onclick={addEditorRow}>+</button>
    </div>
    <footer class="dialog-actions">
      <button onclick={save} disabled={saving}>保存</button>
    </footer>
  </dialog>
{/if}

<style>
  .panel{padding:16px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary)}
  header,.row,.dialog-title,.dialog-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}
  h2{margin:0;font-size:var(--font-size-xl)}.hint{margin:6px 0 0;color:var(--text-muted);font-size:var(--font-size-sm)}
  button,input{border:1px solid var(--border-color);border-radius:5px;background:var(--bg-primary);color:var(--text-primary);padding:7px 10px}
  .rows{display:grid;gap:8px;margin-top:14px}.row{min-width:0;padding:8px 0;border-bottom:1px solid var(--border-color)}
  .name{display:flex;min-width:0;align-items:center;gap:7px;overflow:hidden;font:var(--font-size-sm) var(--font-mono);text-overflow:ellipsis;white-space:nowrap}em{font-size:var(--font-size-xs);color:var(--accent-orange);font-style:normal}
  .value{flex:1 1 auto;min-width:0;overflow:hidden;color:var(--text-secondary);font:var(--font-size-sm) var(--font-mono);text-align:right;text-overflow:ellipsis;white-space:nowrap}
  .error{color:var(--accent-red);font-size:var(--font-size-md)}.empty{color:var(--text-secondary);font-size:var(--font-size-md)}
  dialog.viewport-modal{position:fixed;inset:0;margin:auto;z-index:10;box-sizing:border-box;width:min(720px,calc(100% - 32px));max-height:calc(100% - 48px);overflow:auto;padding:18px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary);color:var(--text-primary);box-shadow:0 18px 50px #0008}
  dialog h3{margin:0;font-size:var(--font-size-xl)}.editor-rows{display:grid;gap:12px;margin-top:14px}.editor-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto auto;align-items:end;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--border-color)}.editor-row>*{min-width:0}
  dialog label{display:grid;gap:6px;font-size:var(--font-size-md)}dialog input{box-sizing:border-box;width:100%;min-width:0}dialog .checkbox{display:flex;align-items:center;padding-bottom:7px}.checkbox input{width:auto;margin:0}.add-button{display:block;margin-top:14px}.close-button{font-size:18px;line-height:1}.dialog-actions{justify-content:flex-end;margin-top:18px}
  @media(max-width:900px){.editor-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
  @media(max-width:600px){.panel > header{align-items:flex-start;flex-direction:column}.dialog-title{flex-direction:row;justify-content:space-between;align-items:center}.editor-row{grid-template-columns:minmax(0,1fr)}}
</style>
