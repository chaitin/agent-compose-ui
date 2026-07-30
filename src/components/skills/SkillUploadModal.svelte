<script lang="ts">
  interface Props { agents: string[]; agent: string; busy: boolean; onAgent: (value: string) => void; onSubmit: (name: string, file: File) => void; onClose: () => void; }
  let { agents, agent, busy, onAgent, onSubmit, onClose }: Props = $props();
  let file = $state<File>(); let name = $state(''); let error = $state('');
  async function choose(event: Event) {
    const chosen = (event.currentTarget as HTMLInputElement).files?.[0]; file = undefined; name = ''; error = '';
    if (!chosen || chosen.name !== 'SKILL.md') { error = '仅支持名为 SKILL.md 的单个 UTF-8 文件。'; return; }
    try {
      const text = await chosen.text();
      if (text.includes('\uFFFD')) throw new Error();
      const match = text.match(/^---\s*\n[\s\S]*?^name:\s*([a-z][a-z0-9_-]*)\s*$/m);
      if (!match) { error = 'SKILL.md 必须包含有效的 name 字段。'; return; }
      file = chosen; name = match[1];
    } catch { error = 'SKILL.md 必须是 UTF-8 文本。'; }
  }
</script>
<div class="resource-modal-backdrop">
<dialog class="resource-modal-card command-modal" open aria-labelledby="skill-upload-title" onkeydown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
  <form class="command-modal-form" onsubmit={(e) => { e.preventDefault(); if (file && name) onSubmit(name, file); }}>
    <div class="command-header"><h2 id="skill-upload-title">上传 Skill</h2><p class="command-status">单个 UTF-8 <code>SKILL.md</code></p></div>
    <div class="command-fields"><label class="command-field">选择文件<input aria-label="选择 SKILL.md" type="file" accept=".md,text/markdown,text/plain" onchange={choose} disabled={busy} /></label>
    <label class="command-field">目标 Agent<select aria-label="目标 Agent" value={agent} onchange={(e) => onAgent(e.currentTarget.value)} disabled={busy}>{#each agents as item}<option value={item}>{item}</option>{/each}</select></label></div>
    <div class="command-footer">{#if name}<p class="command-status" role="status">将上传为 {name}/SKILL.md</p>{:else if error}<p class="command-status" role="alert">{error}</p>{/if}<button class="ui-button ghost" type="button" onclick={onClose} disabled={busy}>取消</button><button class="ui-button primary" type="submit" disabled={busy || !file || !agent}>确认上传</button></div>
  </form>
</dialog>
</div>
<style>
  dialog { width: min(480px, 100%); padding: 0; }
  form { padding: 0; }
</style>
