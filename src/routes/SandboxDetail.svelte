<script lang="ts">
  import PageContent from '$lib/components/page-content.svelte';
  import SandboxWorkbench from '$lib/components/sandbox-workbench.svelte';
  import { router } from '$lib/router.svelte';

  const sandboxId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
</script>

<div data-page-layout="detail" class="flex h-full min-h-0 flex-col overflow-hidden">
  <h1 class="sr-only">执行环境</h1>
  <PageContent compact class="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
    <SandboxWorkbench {sandboxId} />
  </PageContent>
</div>
