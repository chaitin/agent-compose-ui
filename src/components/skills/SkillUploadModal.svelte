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
<dialog open aria-labelledby="skill-upload-title" onkeydown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
  <form onsubmit={(e) => { e.preventDefault(); if (file && name) onSubmit(name, file); }}>
    <h2 id="skill-upload-title">上传 Skill</h2>
    <p>仅上传单个 UTF-8 <code>SKILL.md</code>；不支持 ZIP 或目录包。</p>
    <label>选择 SKILL.md<input aria-label="选择 SKILL.md" type="file" accept=".md,text/markdown,text/plain" onchange={choose} disabled={busy} /></label>
    <label>目标 Agent<select aria-label="目标 Agent" value={agent} onchange={(e) => onAgent(e.currentTarget.value)} disabled={busy}>{#each agents as item}<option value={item}>{item}</option>{/each}</select></label>
    {#if name}<p role="status">将上传为 {name}/SKILL.md</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
    <div class="actions"><button class="ui-button ghost" type="button" onclick={onClose} disabled={busy}>取消</button><button class="ui-button primary" type="submit" disabled={busy || !file || !agent}>确认上传</button></div>
  </form>
</dialog>
<style>
  dialog { position: fixed; inset: 0; z-index: 1000; width: min(480px, 90vw); padding: 0; color: inherit; background: var(--bg-secondary); border: 1px solid var(--border-color); }
  form { display: grid; gap: 12px; padding: 18px; }
  label { display: grid; gap: 4px; } .actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
