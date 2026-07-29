<script lang="ts">
  import EventRunList from './event-run-list.svelte';
  import EventSummaryCard from './event-summary-card.svelte';
  import EventTimeline from './event-timeline.svelte';
  import type { TopicEvent } from '../../api/loaders';
  import type { EventRunTrace, EventTimelineItem } from '../../model/event-detail';

  let {
    event,
    runTraces,
    timeline,
  }: {
    event: TopicEvent;
    runTraces: EventRunTrace[];
    timeline: EventTimelineItem[];
  } = $props();
</script>

<div data-scroll-pane class="min-h-0 flex-1 overflow-y-auto pr-1">
  <div class="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.6fr)]">
    <div class="space-y-4">
      <EventRunList {runTraces} layout="grid" />
      <EventTimeline {timeline} />
    </div>
    <EventSummaryCard {event} />
  </div>
</div>
