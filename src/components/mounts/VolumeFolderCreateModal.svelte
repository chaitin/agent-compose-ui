<script lang="ts">
  import { tick } from 'svelte';
  interface Props {
    value: string;
    busy: boolean;
    onValue: (value: string) => void;
    onSubmit: (name: string) => void;
    onClose: () => void;
  }
  let { value, busy, onValue, onSubmit, onClose }: Props = $props();
  let nameInput: HTMLInputElement;
  const canSubmit = $derived(value.trim().length > 0 && !busy);

  $effect(() => { if (!busy) void tick().then(() => nameInput?.focus()); });

  function close() { if (!busy) onClose(); }
  function submit() { if (canSubmit) onSubmit(value.trim()); }
  function onKeydown(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="resource-modal-backdrop modal-backdrop" onclick={close} role="presentation">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resource-modal-card command-modal modal-card" role="dialog" aria-modal="true" aria-labelledby="volume-folder-create-title" onclick={(event) => event.stopPropagation()} onkeydown={onKeydown} tabindex="-1">
    <form aria-label="新建文件夹表单" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <div class="command-header"><div class="command-title"><div class="modal-title" id="volume-folder-create-title">新建文件夹</div><span class="command-context">VOLUME / CREATE</span></div></div>
      <div class="command-fields">
        <label class="command-field field">
          <span class="field-label">目录名</span>
          <input bind:this={nameInput} disabled={busy} type="text" value={value} placeholder="例如 documents" oninput={(event) => onValue(event.currentTarget.value)} />
        </label>
      </div>
      <div class="command-footer modal-actions">
        <div class="command-status preview">创建在当前目录</div>
        <button class="ui-button ghost" type="button" disabled={busy} onclick={close}>取消</button>
        <button class="ui-button primary" type="submit" disabled={!canSubmit}>{busy ? '正在创建…' : '创建'}</button>
      </div>
    </form>
  </div>
</div>

<style>
  .modal-backdrop { z-index: 1000; }
  .modal-card { width: min(660px, 100%); }
  form { display: flex; flex-direction: column; gap: 10px; }
  .modal-title { font-size: var(--font-size-md); font-weight: 600; color: var(--text-primary); }
  .field { display: flex; gap: 7px; }
  .field-label { font-size: var(--font-size-sm); color: var(--text-secondary); }
  input { background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary); padding: 6px 8px; border-radius: 4px; font-size: var(--font-size-md); font-family: var(--font-mono); }
  input:focus { outline: none; border-color: var(--accent-blue); }
  .preview { margin-right: auto; font-size: var(--font-size-sm); color: var(--text-muted); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
