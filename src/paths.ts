const rawBase = import.meta.env.BASE_URL || '/';
const rootBasePath = rawBase === '/' ? '' : rawBase.replace(/\/$/, '');

export function apiPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${rootBasePath}${normalized}` || '/';
}

export function connectBaseUrl(): string {
  return `${window.location.origin}${rootBasePath}`;
}

export function appPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized === '/') {
    return `${rootBasePath}/` || '/';
  }
  return `${rootBasePath}${normalized}`;
}

export function stripAppBase(pathname: string): string {
  if (!rootBasePath) {
    return pathname;
  }
  if (pathname === rootBasePath || pathname === `${rootBasePath}/`) {
    return '/';
  }
  if (pathname.startsWith(`${rootBasePath}/`)) {
    return `/${pathname.slice(rootBasePath.length + 1)}`;
  }
  return pathname;
}
