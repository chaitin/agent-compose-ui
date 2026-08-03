import { appPath } from '../paths';

export type JupyterLocation = {
  proxyPath?: string | null;
  notebookUrl?: string | null;
};

/**
 * The daemon currently assigns a proxy path to every Sandbox, including ones
 * without Jupyter. A notebook URL is only returned after the daemon has
 * confirmed that the Sandbox has an enabled, exposed Jupyter proxy.
 */
export function hasJupyter(location: JupyterLocation | null | undefined): boolean {
  return Boolean(location?.notebookUrl?.trim());
}

function sameOriginPath(value: string): string {
  try {
    const parsed = new URL(value, 'http://agent-compose-ui.local');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const entryPath = parsed.pathname.replace(/\/lab(?:\/.*)?\/?$/, '').replace(/\/$/, '');
    return entryPath || parsed.pathname;
  } catch {
    return '';
  }
}

function withApplicationBase(path: string): string {
  if (!path) return '';
  const base = import.meta.env.BASE_URL || '/';
  const rootBase = base === '/' ? '' : base.replace(/\/$/, '');
  if (rootBase && (path === rootBase || path.startsWith(`${rootBase}/`))) return path;
  return appPath(path);
}

/**
 * Returns the same-origin, token-free Jupyter entry route. The daemon's entry
 * handler ensures the Sandbox is ready and redirects to Lab with its token.
 */
export function jupyterEntryHref(location: JupyterLocation | null | undefined): string {
  if (!hasJupyter(location)) return '';
  const candidate = location?.proxyPath?.trim() || location?.notebookUrl?.trim() || '';
  if (!candidate) return '';
  return withApplicationBase(sameOriginPath(candidate));
}
