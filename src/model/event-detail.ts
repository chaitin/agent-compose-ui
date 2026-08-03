import type { TopicEventTraceRun } from '../api/loaders';

export type EventRunTrace = TopicEventTraceRun;

export type EventTimelineItem = {
  id: string;
  createdAt: string;
  type: string;
  message: string;
};
