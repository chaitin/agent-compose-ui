// 侧栏导航配置：三组（工作区 / 资源 / 系统），对应设计文档 §4.1 站点地图。
import type { Component } from 'svelte';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import Bot from '@lucide/svelte/icons/bot';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import Activity from '@lucide/svelte/icons/activity';
import Webhook from '@lucide/svelte/icons/webhook';
import Box from '@lucide/svelte/icons/box';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import Cable from '@lucide/svelte/icons/cable';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Settings from '@lucide/svelte/icons/settings';
import Database from '@lucide/svelte/icons/database';
import MessagesSquare from '@lucide/svelte/icons/messages-square';
import ScrollText from '@lucide/svelte/icons/scroll-text';
import { t } from '$lib/i18n.svelte';

export type NavItem = {
  label: string;
  href: string;
  icon: Component;
  /** 归属的顶层区段，用于匹配当前高亮（含详情子路由）。 */
  match?: (path: string) => boolean;
};

export type NavGroup = {
  title: string;
  items: NavItem[];
};

const startsWith = (prefix: string) => (path: string) => path === prefix || path.startsWith(`${prefix}/`);

const navGroupDefinitions: NavGroup[] = [
  {
    title: '工作区',
    items: [
      { label: '概览', href: '/', icon: LayoutDashboard, match: (p) => p === '/' },
      { label: '智能体', href: '/agents', icon: Bot, match: startsWith('/agents') },
      { label: '自动化任务', href: '/automations', icon: CalendarClock, match: startsWith('/automations') },
      {
        label: '运行',
        href: '/runs',
        icon: Activity,
        match: startsWith('/runs'),
      },
      { label: '对话记录', href: '/conversations', icon: MessagesSquare, match: startsWith('/conversations') },
      { label: '事件', href: '/events', icon: Webhook, match: startsWith('/events') },
    ],
  },
  {
    title: '资源',
    items: [
      { label: '镜像', href: '/images', icon: Box, match: startsWith('/images') },
      { label: '能力集', href: '/capabilities', icon: ShieldCheck, match: startsWith('/capabilities') },
      { label: 'MCP 服务', href: '/mcp', icon: Cable, match: startsWith('/mcp') },
      { label: 'Skills', href: '/skills', icon: Sparkles, match: startsWith('/skills') },
    ],
  },
  {
    title: '系统',
    items: [
      { label: '审计日志', href: '/audit', icon: ScrollText, match: startsWith('/audit') },
      { label: '缓存', href: '/settings/caches', icon: Database, match: startsWith('/settings/caches') },
      {
        label: '设置',
        href: '/settings',
        icon: Settings,
        match: (p) => startsWith('/settings')(p) && !startsWith('/settings/caches')(p),
      },
    ],
  },
];

export function navGroups(): NavGroup[] {
  return navGroupDefinitions.map((group) => ({
    ...group,
    title: t(group.title),
    items: group.items.map((item) => ({ ...item, label: t(item.label) })),
  }));
}

export function allNavItems(): NavItem[] {
  return navGroups().flatMap((group) => group.items);
}

/** 面包屑：根据当前路径推导（列表 / 详情两层）。 */
export function breadcrumbs(path: string): { label: string; href?: string }[] {
  if (path === '/') return [{ label: t('概览') }];
  const top = allNavItems().find((i) => i.href !== '/' && i.match?.(path));
  if (!top) return [{ label: t('概览'), href: '/' }];
  const crumbs: { label: string; href?: string }[] = [{ label: top.label, href: top.href }];
  const rest = path.slice(top.href.length).split('/').filter(Boolean);
  if (rest.length > 0) {
    crumbs.push({ label: rest[0] }); // 详情 id
    if (rest.length > 1) crumbs.push({ label: rest[1] }); // 子视图（如 terminal）
  } else {
    crumbs[0] = { label: top.label };
  }
  return crumbs;
}
