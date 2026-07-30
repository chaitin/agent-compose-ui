<script lang="ts">
  interface Props {
    name: string;
    content: string;
    dirty: boolean;
    busy: boolean;
    reading: boolean;
    conflict: boolean;
    onContent: (value: string) => void;
    onSave: () => void;
    onDelete: () => void;
    onReload: () => void;
  }

  let { name, content, dirty, busy, reading, conflict, onContent, onSave, onDelete, onReload }: Props = $props();
  const instanceId = $props.id();
</script>

<section class="editor" aria-label="Skill 编辑器">
  {#if name}
    <header>
      <h2 id={`${instanceId}-title`}>{name}/SKILL.md</h2>
      <span>{dirty ? '有未保存更改' : '无未保存更改'}</span>
    </header>
    {#if reading}
      <p role="status">正在读取 SKILL.md…</p>
    {:else}
      <label class="editor-label">
        SKILL.md 内容
        <textarea
          aria-labelledby={`${instanceId}-title`}
          value={content}
          oninput={(event) => onContent(event.currentTarget.value)}
        ></textarea>
      </label>
      <div class="actions">
        <button class="ui-button primary" type="button" onclick={onSave} disabled={busy || !dirty}>保存 Skill</button>
        <button class="ui-button danger" type="button" onclick={onDelete} disabled={busy}>删除 Skill</button>
        {#if conflict}<button class="ui-button secondary" type="button" onclick={onReload}>重新加载磁盘内容</button>{/if}
      </div>
    {/if}
  {:else}
    <p>请选择一个 Skill 编辑。</p>
  {/if}
</section>

<style>
  .editor { height: 100%; padding: 10px; min-width: 0; overflow: auto; }
  header, .actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  h2 { margin: 0; font-size: 14px; }
  .editor-label { display: grid; gap: 3px; height: calc(100% - 55px); margin: 8px 0; color: var(--text-secondary); }
  textarea { width: 100%; min-height: 140px; resize: vertical; color: var(--text-primary); background: var(--bg-primary); border: 1px solid var(--border-color); font-family: var(--font-mono); }
</style>
