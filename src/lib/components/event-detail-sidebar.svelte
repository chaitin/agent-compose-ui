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

<aside data-scroll-pane class="min-w-0 space-y-4 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:pr-1">
  <EventSummaryCard {event} />
  <EventRunList {runTraces} />
  <EventTimeline {timeline} />
</aside>
