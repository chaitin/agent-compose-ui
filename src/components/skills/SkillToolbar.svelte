<script lang="ts">
  interface Props {
    busy: boolean;
    onCreate: () => void;
    onUpload: () => void;
    onRefresh: () => void;
  }

  let { busy, onCreate, onUpload, onRefresh }: Props = $props();
</script>

<div class="toolbar" role="toolbar" aria-label="Skill 操作">
  <button type="button" onclick={onCreate} disabled={busy}>新建 Skill</button>
  <button type="button" onclick={onUpload} disabled={busy}>上传 Skill</button>
  <span class="spacer"></span>
  <button type="button" onclick={onRefresh} disabled={busy}>刷新</button>
</div>

<style>
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border-color); }
  .spacer { flex: 1; }
</style>
