<script lang="ts">
  let { projectId = '', sandboxId = '', showBreadcrumb = true }: { projectId?: string; sandboxId?: string; showBreadcrumb?: boolean } = $props();
</script>

<div data-testid="embedded-sandbox" data-project-id={projectId} data-sandbox-id={sandboxId} data-show-breadcrumb={showBreadcrumb}></div>
