<script lang="ts">
  let { onCreateFile }: { onCreateFile: () => void } = $props();
</script>

<button type="button" onclick={onCreateFile}>新建脚本</button>
