export const CACHE_PRESETS = Object.freeze({
  npm: Object.freeze({ target: '/root/.npm', suffix: 'npm-cache' }),
  pip: Object.freeze({ target: '/root/.cache/pip', suffix: 'pip-cache' }),
  tools: Object.freeze({ target: '/root/.cache', suffix: 'tools-cache' }),
} as const);
