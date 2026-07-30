<script lang="ts">
  import { tick } from 'svelte';
  interface Props { agents: string[]; busy: boolean; name: string; agent: string; onName: (value: string) => void; onAgent: (value: string) => void; onSubmit: () => void; onClose: () => void; }
  let { agents, busy, name, agent, onName, onAgent, onSubmit, onClose }: Props = $props();
  let input = $state<HTMLInputElement>();
  $effect(() => { void tick().then(() => input?.focus()); });
</script>
<div class="resource-modal-backdrop">
<dialog class="resource-modal-card" open aria-labelledby="skill-create-title" onkeydown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
  <form onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <h2 id="skill-create-title">新建 Skill</h2>
    <label>Skill 名称<input bind:this={input} aria-label="Skill 名称" value={name} oninput={(e) => onName(e.currentTarget.value)} pattern="[a-z][a-z0-9_-]*" required disabled={busy} /></label>
    <label>目标 Agent<select aria-label="目标 Agent" value={agent} onchange={(e) => onAgent(e.currentTarget.value)} disabled={busy}>{#each agents as item}<option value={item}>{item}</option>{/each}</select></label>
    <div class="actions"><button class="ui-button ghost" type="button" onclick={onClose} disabled={busy}>取消</button><button class="ui-button primary" type="submit" disabled={busy || !agent}>创建 Skill</button></div>
  </form>
</dialog>
</div>
<style>
  dialog { width: min(440px, 100%); padding: 0; }
  form { display: grid; gap: 12px; padding: 18px; }
  label { display: grid; gap: 4px; } .actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
