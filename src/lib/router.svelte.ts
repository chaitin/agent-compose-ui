// 极简客户端路由：用 Svelte 5 runes 承载当前路径，pushState + popstate 驱动。
// 取代原项目 App.svelte 里手写的 pageFromPath/popstate 逻辑，统一为单一 navigate()。

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(pathname: string): string {
  if (BASE && pathname.startsWith(BASE)) {
    const rest = pathname.slice(BASE.length);
    return rest === '' ? '/' : rest;
  }
  return pathname || '/';
}

function withBase(path: string): string {
  return `${BASE}${path}`;
}

function pathFromTarget(target: string): string {
  return stripBase(new URL(withBase(target), window.location.origin).pathname);
}

class Router {
  path = $state(stripBase(window.location.pathname));
  private currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  private readonly scrollPositions = new Map<string, number>();

  constructor() {
    window.history.scrollRestoration = 'manual';
    window.addEventListener('popstate', () => {
      this.saveScrollPosition();
      this.currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      this.path = stripBase(window.location.pathname);
      this.restoreScrollPosition(this.currentLocation);
    });
  }

  navigate = (to: string): void => {
    const target = withBase(to);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (target === current) return;
    this.saveScrollPosition();
    window.history.pushState({}, '', withBase(to));
    this.currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    this.path = pathFromTarget(to);
    this.scrollTo(0);
  };

  replace = (to: string): void => {
    const previous = this.currentLocation;
    window.history.replaceState({}, '', withBase(to));
    this.currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const position = this.scrollPositions.get(previous);
    if (position !== undefined) this.scrollPositions.set(this.currentLocation, position);
    this.path = pathFromTarget(to);
  };

  sync = (): void => {
    this.currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    this.path = stripBase(window.location.pathname);
  };

  private saveScrollPosition(): void {
    const root = document.querySelector<HTMLElement>('[data-scroll-root]');
    if (root) this.scrollPositions.set(this.currentLocation, root.scrollTop);
  }

  private scrollTo(top: number): void {
    document.querySelector<HTMLElement>('[data-scroll-root]')?.scrollTo({ top });
  }

  private restoreScrollPosition(location: string): void {
    const top = this.scrollPositions.get(location) ?? 0;
    let attempts = 0;
    let stableAttempts = 0;
    const restore = (): void => {
      if (this.currentLocation !== location) return;
      const root = document.querySelector<HTMLElement>('[data-scroll-root]');
      if (!root) return;
      if (root.scrollHeight - root.clientHeight >= top - 1) {
        root.scrollTo({ top });
        stableAttempts = Math.abs(root.scrollTop - top) <= 1 ? stableAttempts + 1 : 0;
      } else {
        stableAttempts = 0;
      }
      if (stableAttempts >= 3 || attempts >= 100) return;
      attempts += 1;
      window.setTimeout(restore, 50);
    };
    window.requestAnimationFrame(restore);
  }
}

export const router = new Router();
export const navigate = router.navigate;

/** 匹配 /runs/:id 之类的详情路由，返回捕获的 id（否则 null）。 */
export function matchDetail(prefix: string, path: string): string | null {
  const m = path.match(new RegExp(`^${prefix}/([^/]+)`));
  return m ? m[1] : null;
}
