export type EventSemanticStatus = 'running' | 'success' | 'failed' | 'skipped' | 'pending' | 'stopped';

export type EventStatusPresentation = {
  semantic: EventSemanticStatus;
  label: string;
  description: string;
};

const dispatchStatuses: Record<string, EventStatusPresentation> = {
  pending: { semantic: 'pending', label: '等待投递', description: '事件已保存，正在等待发布。' },
  publishing_to_bus: { semantic: 'running', label: '正在投递', description: '事件正在发布到事件总线。' },
  published_to_bus: { semantic: 'success', label: '已投递', description: '事件已成功发布到事件总线。' },
  no_subscriber: { semantic: 'skipped', label: '无订阅方', description: '事件已发布，但没有匹配的订阅方。' },
  retrying: { semantic: 'running', label: '正在重试', description: '上次投递失败，系统正在重试。' },
  dead_letter: { semantic: 'failed', label: '死信', description: '事件重试耗尽，需要人工检查。' },
};

const deliveryStatuses: Record<string, EventStatusPresentation> = {
  matched: { semantic: 'pending', label: '已匹配', description: '事件已匹配自动化任务。' },
  run_started: { semantic: 'running', label: '运行已启动', description: '关联自动化运行已经启动。' },
  run_succeeded: { semantic: 'success', label: '运行成功', description: '关联自动化运行成功完成。' },
  run_failed: { semantic: 'failed', label: '运行失败', description: '关联自动化运行执行失败。' },
  skipped: { semantic: 'skipped', label: '已跳过', description: '关联自动化运行被跳过。' },
};

function fallback(value: string): EventStatusPresentation {
  const label = value.trim() || '未知';
  return { semantic: 'pending', label, description: '后端返回了尚未识别的状态。' };
}

export function dispatchStatus(value: string): EventStatusPresentation {
  return dispatchStatuses[value.trim().toLowerCase()] ?? fallback(value);
}

export function deliveryStatus(value: string): EventStatusPresentation {
  const normalized = value.trim().toLowerCase();
  if (deliveryStatuses[normalized]) return deliveryStatuses[normalized];
  if (['succeeded', 'success', 'completed'].includes(normalized)) return deliveryStatuses.run_succeeded;
  if (['failed', 'failure', 'error'].includes(normalized)) return deliveryStatuses.run_failed;
  if (['running', 'started'].includes(normalized)) return deliveryStatuses.run_started;
  if (['canceled', 'cancelled'].includes(normalized))
    return { semantic: 'stopped', label: '已取消', description: '关联自动化运行已取消。' };
  return fallback(value);
}

export const dispatchStatusLegend = [
  dispatchStatuses.pending,
  dispatchStatuses.publishing_to_bus,
  dispatchStatuses.published_to_bus,
  dispatchStatuses.no_subscriber,
  dispatchStatuses.dead_letter,
];

export function eventSourceLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'webhook') return 'Webhook';
  if (normalized === 'loader') return '自动化任务';
  if (normalized === 'system') return '系统';
  return value || '未知';
}
