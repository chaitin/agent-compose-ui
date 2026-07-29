import type { AutomationEvent, AutomationRun, AutomationTaskDetail, TopicEventRun } from '../api/loaders';

export type EventRunTrace = {
  delivery: TopicEventRun;
  run: AutomationRun | null;
  task: AutomationTaskDetail | null;
  events: AutomationEvent[];
};

export type EventTimelineItem = {
  id: string;
  createdAt: string;
  type: string;
  message: string;
};
