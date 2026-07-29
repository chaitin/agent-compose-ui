import type { ProjectChange } from '../api/projects';

export type PresentedChange = {
  key: string;
  name: string;
  resourceLabel: string;
  actionLabel: string;
  status: string;
  rawTypes: string[];
  rawAction: string;
};

const resourceLabels: Record<string, string> = {
  project: '项目',
  project_agent: '智能体配置',
  agent_definition: '智能体配置',
  project_scheduler: '自动化配置',
  scheduler: '自动化配置',
  image: '镜像',
  workspace: '工作目录',
  capability_set: '能力集',
  mcp_server: 'MCP 服务',
  skill: 'Skill',
};

export function resourceTypeLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return resourceLabels[normalized] ?? '配置';
}

export function projectChangeAction(value: string): { label: string; status: string } {
  const normalized = value.trim().toUpperCase();
  if (normalized.includes('CREATED') || normalized.includes('ADDED')) return { label: '新增', status: 'created' };
  if (normalized.includes('REMOVED') || normalized.includes('DELETED')) return { label: '删除', status: 'removed' };
  if (normalized.includes('UNCHANGED')) return { label: '无变化', status: 'unchanged' };
  return { label: '更新', status: 'updated' };
}

export function presentProjectChanges(changes: ProjectChange[]): PresentedChange[] {
  const result = new Map<string, PresentedChange>();
  for (const change of changes) {
    const action = projectChangeAction(change.action);
    if (action.status === 'unchanged') continue;
    const resourceLabel = resourceTypeLabel(change.resourceType);
    const name = change.name.trim() || resourceLabel;
    const key = `${action.status}:${resourceLabel}:${name}`;
    const current = result.get(key);
    if (current) {
      if (!current.rawTypes.includes(change.resourceType)) current.rawTypes.push(change.resourceType);
      continue;
    }
    result.set(key, {
      key,
      name,
      resourceLabel,
      actionLabel: action.label,
      status: action.status,
      rawTypes: [change.resourceType],
      rawAction: change.action,
    });
  }
  return [...result.values()];
}

export function validationPathLabel(path: string): string {
  const normalized = path.trim().toLowerCase();
  if (!normalized) return '项目配置';
  if (normalized.includes('scheduler')) return '自动化配置';
  if (normalized.includes('agents')) return '智能体配置';
  if (normalized.includes('workspace')) return '工作目录';
  if (normalized.includes('mcp')) return 'MCP 服务';
  if (normalized.includes('skill')) return 'Skill 配置';
  return '项目配置';
}

export function triggerKindLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'event') return '事件';
  if (normalized === 'cron') return '定时';
  if (normalized === 'interval') return '固定间隔';
  if (normalized === 'timeout') return '延时';
  if (normalized === 'manual') return '手动';
  return value || '未知';
}

export function auditActionLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'login') return '登录';
  if (normalized === 'logout') return '退出登录';
  if (normalized === 'token.access') return '使用 API 令牌';
  if (normalized === 'access.denied') return '访问被拒绝';
  if (normalized === 'terminal.attach') return '连接终端';
  if (normalized === 'applyproject') return '部署项目';
  if (normalized === 'runagentstream') return '运行智能体';
  if (normalized === 'resumesandbox') return '恢复执行环境';
  if (normalized.includes('/api/ui/v1/project-deployment-previews')) return '预览项目变更';
  if (normalized.startsWith('post /api/ui/v1/tokens')) return '创建 API 令牌';
  if (normalized.startsWith('delete /api/ui/v1/tokens/')) return '撤销 API 令牌';
  if (normalized.includes('/api/webhooks/')) return '接收 Webhook';
  if (normalized.includes('/api/webhook-sources/')) return '更新 Webhook 来源';
  if (normalized.includes('workspacepreset')) return '更新工作目录预设';
  return '系统操作';
}
