<script lang="ts">
  let { files = [], activePath = '', onSelect = () => {} }: { files?: unknown[]; activePath?: string; onSelect?: (path: string) => void } = $props();
</script>
<div class="workspace-tree-stub" data-active={activePath}>file tree stub</div>
