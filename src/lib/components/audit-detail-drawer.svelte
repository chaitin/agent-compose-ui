<script lang="ts">
  import CopyableText from '$lib/components/copyable-text.svelte';
  import SideDrawer from '$lib/components/side-drawer.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import TechnicalDetails from '$lib/components/technical-details.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { AuditEvent } from '../../api/audit';
  import { auditActionLabel, resourceTypeLabel } from '../../model/presentation';

  let { event, onClose }: { event: AuditEvent | null; onClose: () => void } = $props();

  const outcomeLabel = (value: string) =>
    t({ success: '成功', failure: '失败', denied: '拒绝', started: '进行中' }[value] || value);
  const outcomeStatus = (value: string) =>
    value === 'success' ? 'success' : value === 'started' ? 'running' : 'failed';
</script>

<SideDrawer
  open={Boolean(event)}
  onOpenChange={(open) => !open && onClose()}
  title={t('审计详情')}
  description={event ? `${t(auditActionLabel(event.action))} · ${event.actor.displayName || event.actor.username}` : ''}
>
  {#if event}
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <StatusBadge status={outcomeStatus(event.outcome)} label={outcomeLabel(event.outcome)} />
      <Timestamp value={event.occurredAt} mode="full" />
    </div>
    <dl class="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt class="text-muted-foreground">{t('用户')}</dt>
      <dd>{event.actor.displayName || event.actor.username}</dd>
      <dt class="text-muted-foreground">{t('操作')}</dt>
      <dd>{t(auditActionLabel(event.action))}</dd>
      <dt class="text-muted-foreground">{t('资源')}</dt>
      <dd class="min-w-0">
        {#if event.resourceId}
          <CopyableText
            value={event.resourceId}
            display={`${t(resourceTypeLabel(event.resourceType))} · ${event.resourceId}`}
            label="资源 ID"
            class="max-w-full"
          />
        {:else if event.resourceType}{t(resourceTypeLabel(event.resourceType))}{:else}—{/if}
      </dd>
      <dt class="text-muted-foreground">{t('耗时')}</dt>
      <dd>{event.durationMs} ms</dd>
    </dl>
    <TechnicalDetails
      title="请求详情"
      class="mt-5"
      items={[
        { label: '审计事件 ID', value: event.id },
        { label: '用户 ID', value: event.actor.id },
        { label: '接口', value: `${event.method} ${event.path}`, copyable: false },
        { label: 'HTTP 状态', value: String(event.status), copyable: false },
        { label: 'Request ID', value: event.requestId },
        { label: 'IP', value: event.remoteIp },
        { label: 'User-Agent', value: event.userAgent, copyable: false },
        { label: '认证方式', value: event.actor.authMethod, copyable: false },
        { label: '原始操作', value: event.action, copyable: false },
        { label: '原始资源类型', value: event.resourceType, copyable: false },
      ]}
    />
  {/if}
</SideDrawer>
