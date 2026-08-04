<script lang="ts">
  interface Props {
    name: string;
    content: string;
    dirty: boolean;
    busy: boolean;
    reading: boolean;
    conflict: boolean;
    saveStatus: string;
    onContent: (value: string) => void;
    onSave: () => void;
    onReload: () => void;
  }

  let { name, content, dirty, busy, reading, conflict, saveStatus, onContent, onSave, onReload }: Props = $props();
</script>

<section class="editor" aria-label="Skill 编辑器">
  {#if name}
    {#if reading}
      <p role="status">正在读取 SKILL.md…</p>
    {:else}
      <div class="editor-label">
        <div class="editor-label-row">
          <span>SKILL.md 内容</span>
          <div class="save-actions">
            {#if saveStatus && !dirty}<span class="save-status" role="status">{saveStatus}</span>{/if}
            <button
              class="save-icon"
              type="button"
              onclick={onSave}
              disabled={busy || !dirty}
              aria-label="保存 Skill"
              title="保存 Skill"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 3h12l2 2v16H5V3Zm2 2v5h8V5H7Zm0 14h10v-7H7v7Zm2-5h6v3H9v-3Z" />
              </svg>
            </button>
          </div>
        </div>
        <textarea
          aria-label={`${name}/SKILL.md`}
          value={content}
          oninput={(event) => onContent(event.currentTarget.value)}
        ></textarea>
      </div>
      {#if conflict}<div class="actions"><button class="ui-button secondary" type="button" onclick={onReload}>重新加载磁盘内容</button></div>{/if}
    {/if}
  {:else}
    <p>请选择一个 Skill 编辑。</p>
  {/if}
</section>

<style>
  .editor {
    box-sizing: border-box;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 3px;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: 4px;
    overflow: hidden;
  }
  .actions, .editor-label-row, .save-actions { display: flex; align-items: center; gap: 4px; }
  .editor-label-row { justify-content: space-between; }
  .save-status { color: var(--accent-green); font-size: var(--font-size-xs); }
  .save-icon { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--accent-blue); cursor: pointer; }
  .save-icon:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-blue) 12%, transparent); }
  .save-icon:disabled { color: var(--text-muted); cursor: not-allowed; opacity: .5; }
  .save-icon svg { width: 16px; height: 16px; fill: currentColor; }
  .editor-label {
    display: grid;
    grid-template-rows: auto minmax(140px, 1fr);
    gap: 2px;
    min-height: 0;
    color: var(--text-secondary);
  }
  textarea {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-height: 140px;
    resize: none;
    color: var(--text-primary);
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    font-family: var(--font-mono);
  }
</style>
