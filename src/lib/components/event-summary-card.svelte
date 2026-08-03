<script lang="ts">
  import CopyableText from './copyable-text.svelte';
  import Timestamp from './timestamp.svelte';
  import { eventSourceLabel } from '../../model/event-status';
  import { t } from '$lib/i18n.svelte';
  import type { TopicEvent } from '../../api/loaders';

  let { event }: { event: TopicEvent } = $props();
</script>

<section class="rounded-lg border border-border bg-card p-4">
  <h2 class="mb-3 text-sm font-medium">{t('事件摘要')}</h2>
  <dl class="grid gap-3 text-sm">
    <div>
      <dt class="text-xs text-muted-foreground">{t('事件 ID')}</dt>
      <dd><CopyableText value={event.eventId} label="事件 ID" class="max-w-full font-mono text-xs" /></dd>
    </div>
    <div>
      <dt class="text-xs text-muted-foreground">{t('事件主题')}</dt>
      <dd class="break-all font-mono text-xs">{event.topic}</dd>
    </div>
    <div>
      <dt class="text-xs text-muted-foreground">{t('来源')}</dt>
      <dd>{eventSourceLabel(event.source)} · {event.provider || '—'}</dd>
    </div>
    <div>
      <dt class="text-xs text-muted-foreground">{t('关联 ID')}</dt>
      <dd class="break-all font-mono text-xs">{event.correlationId || '—'}</dd>
    </div>
    <div>
      <dt class="text-xs text-muted-foreground">{t('创建时间')}</dt>
      <dd><Timestamp value={event.createdAt} mode="full" /></dd>
    </div>
  </dl>
</section>
