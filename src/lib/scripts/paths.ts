const SAFE_SCRIPT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*(?:^|\/)\.metadata(?:\/|$))[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*\.js$/;

export function parseScriptRef(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('$ref:')) return null;
  const path = value.slice(5);
  return SAFE_SCRIPT_PATH.test(path) && !path.includes('\\') ? path : null;
}

export const toScriptRef = (path: string): string => `$ref:${path}`;

export const encodePointer = (parts: string[]): string =>
  `/${parts.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;

export const decodePointer = (pointer: string): string[] =>
  pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
