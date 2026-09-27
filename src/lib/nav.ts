// 侧栏导航：五个一级入口。「运行」是唯一原子，事件与 Sandbox 是它的透镜；
// 资源、系统把原来的零散页面收进同一入口，用页签切换。
import type { Component } from 'svelte';
import Activity from '@lucide/svelte/icons/activity';
import FolderKanban from '@lucide/svelte/icons/folder-kanban';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import Layers from '@lucide/svelte/icons/layers';
import Settings from '@lucide/svelte/icons/settings';
import UserRound from '@lucide/svelte/icons/user-round';
import { t } from '$lib/i18n.svelte';
import { compactIdentifier } from '../model/identifiers';

export type NavTab = {
  label: string;
  href: string;
  match: (path: string) => boolean;
};

export type NavItem = {
  label: string;
  href: string;
  icon: Component;
  /** 归属的顶层区段，用于匹配当前高亮（含详情子路由）。 */
  match: (path: string) => boolean;
  /** 区段内的平级页面；只有一个时不显示页签。 */
  tabs?: NavTab[];
  /** 不出现在侧栏主导航里（从账户菜单进入），但仍参与高亮、页签和面包屑。 */
  hidden?: boolean;
};

const startsWith = (prefix: string) => (path: string) => path === prefix || path.startsWith(`${prefix}/`);
const exactly = (target: string) => (path: string) => path === target;

const navDefinitions: NavItem[] = [
  {
    label: '运行',
    href: '/',
    icon: Activity,
    match: (path) =>
      path === '/' || startsWith('/runs')(path) || startsWith('/sandboxes')(path) || startsWith('/events')(path),
    tabs: [
      { label: '运行', href: '/', match: exactly('/') },
      { label: 'Webhook 事件', href: '/events', match: exactly('/events') },
      { label: 'Sandboxes', href: '/sandboxes', match: exactly('/sandboxes') },
    ],
  },
  {
    label: '项目',
    href: '/projects',
    icon: FolderKanban,
    match: (path) => startsWith('/projects')(path) || startsWith('/agents')(path),
  },
  {
    label: '自动化',
    href: '/automations',
    icon: CalendarClock,
    match: (path) => startsWith('/automations')(path) || startsWith('/automation-runs')(path),
  },
  {
    label: '资源',
    href: '/images',
    icon: Layers,
    match: (path) =>
      ['/images', '/capabilities', '/mcp', '/skills', '/settings/caches'].some((prefix) => startsWith(prefix)(path)),
    tabs: [
      { label: '镜像', href: '/images', match: startsWith('/images') },
      { label: '能力集', href: '/capabilities', match: startsWith('/capabilities') },
      { label: 'MCP 服务', href: '/mcp', match: startsWith('/mcp') },
      { label: 'Skills', href: '/skills', match: startsWith('/skills') },
      { label: '缓存', href: '/settings/caches', match: startsWith('/settings/caches') },
    ],
  },
  {
    label: '系统',
    href: '/settings',
    icon: Settings,
    match: (path) => startsWith('/settings')(path) && !startsWith('/settings/caches')(path),
  },
  {
    // 这个控制台（UI server）自己的东西：登录、个人令牌、审计。和 agent-compose daemon 无关，放在侧栏底部的账户菜单里。
    label: '账户',
    href: '/account',
    icon: UserRound,
    hidden: true,
    match: (path) => startsWith('/account')(path) || startsWith('/audit')(path),
    tabs: [
      { label: '登录信息', href: '/account', match: exactly('/account') },
      { label: 'API 令牌', href: '/account/tokens', match: startsWith('/account/tokens') },
      { label: '审计日志', href: '/audit', match: startsWith('/audit') },
    ],
  },
];

function localize(item: NavItem): NavItem {
  return {
    ...item,
    label: t(item.label),
    tabs: item.tabs?.map((tab) => ({ ...tab, label: t(tab.label) })),
  };
}

/** 侧栏主导航（不含账户区）。 */
export function navItems(): NavItem[] {
  return navDefinitions.filter((item) => !item.hidden).map(localize);
}

/** 账户菜单里的入口。 */
export function accountItems(): NavTab[] {
  return localize(navDefinitions.find((item) => item.hidden)!).tabs ?? [];
}

export function activeNavItem(path: string): NavItem | undefined {
  const item = navDefinitions.find((candidate) => candidate.match(path));
  return item ? localize(item) : undefined;
}

/** 当前路径是区段内的平级列表页时返回页签；详情页不显示页签。 */
export function sectionTabs(path: string): NavTab[] {
  const tabs = activeNavItem(path)?.tabs ?? [];
  const onListPage = tabs.some((tab) => tab.href === path);
  return onListPage && tabs.length > 1 ? tabs : [];
}

/** 面包屑：根据当前路径推导（区段 / 详情两层）。 */
export function breadcrumbs(path: string): { label: string; href?: string }[] {
  if (path === '/') return [{ label: t('运行') }];
  if (startsWith('/automation-runs')(path)) {
    const runId = path.slice('/automation-runs'.length).split('/').filter(Boolean)[0];
    return [
      { label: t('自动化'), href: '/automations' },
      { label: t('自动化执行') },
      ...(runId ? [{ label: compactIdentifier(runId) }] : []),
    ];
  }
  const automationRunsMatch = path.match(/^\/automations\/([^/]+)\/runs$/);
  if (automationRunsMatch) {
    return [
      { label: t('自动化'), href: '/automations' },
      { label: compactIdentifier(decodeURIComponent(automationRunsMatch[1])) },
      { label: t('执行历史') },
    ];
  }
  const item = activeNavItem(path);
  if (!item) return [{ label: t('运行'), href: '/' }];
  // 取前缀最长的页签：/account/tokens 应该归到「API 令牌」而不是「登录信息」。
  const tab = item.tabs
    ?.filter((candidate) => candidate.href !== '/' && startsWith(candidate.href)(path))
    .sort((left, right) => right.href.length - left.href.length)[0];
  if (tab && path === tab.href) return [{ label: item.label }];
  if (startsWith('/runs')(path)) return [{ label: item.label, href: '/' }, { label: t('运行详情') }];
  if (startsWith('/events')(path)) return [{ label: item.label, href: '/' }, { label: t('事件详情') }];
  if (startsWith('/sandboxes')(path)) return [{ label: item.label, href: '/' }, { label: t('Sandbox 详情') }];
  const base = tab ?? item;
  const crumbs: { label: string; href?: string }[] = [{ label: item.label, href: item.href }];
  if (tab) crumbs.push({ label: tab.label, href: tab.href });
  const rest = path.slice(base.href.length).split('/').filter(Boolean);
  if (rest.length > 0) {
    crumbs.push({ label: rest[0] === 'new' ? t('新建') : compactIdentifier(decodeURIComponent(rest[0])) });
    if (rest.length > 1) crumbs.push({ label: rest[1] });
  } else if (crumbs.length === 1) {
    crumbs[0] = { label: item.label };
  }
  return crumbs;
}
