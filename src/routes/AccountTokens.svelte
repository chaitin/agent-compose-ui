<script lang="ts">
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import TokenManagement from '$lib/components/token-management.svelte';
</script>

<div data-page-layout="workbench" class="flex h-full min-h-0 flex-col overflow-hidden">
  <PageHeader title="API 令牌" description="管理当前用户的 API 访问凭据" />
  <PageContent class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <TokenManagement />
  </PageContent>
</div>
