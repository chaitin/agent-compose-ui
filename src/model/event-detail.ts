import type {
  AutomationEvent,
  AutomationRun,
  AutomationTaskDetail,
  TopicEventRun,
  TopicEventSession,
} from '../api/loaders';
import type { WorkSessionCell, WorkSessionDetail, WorkSessionEvent, WorkSessionRunTarget } from '../api/sessions';

export type EventRunTrace = {
  delivery: TopicEventRun;
  run: AutomationRun | null;
  task: AutomationTaskDetail | null;
  events: AutomationEvent[];
};

export type EventSessionTrace = {
  link: TopicEventSession;
  session: WorkSessionDetail | null;
  cells: WorkSessionCell[];
  events: WorkSessionEvent[];
  target?: WorkSessionRunTarget;
};

export type EventTimelineItem = {
  id: string;
  createdAt: string;
  type: string;
  message: string;
};
