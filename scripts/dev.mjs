import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function childSpecs({ executable, gatewayExecutable = 'go', token, authMode = 'disabled', agentComposeURL = '', scriptServiceURL = '', agentComposeDBPath = '', uiStateDBPath = '', goCache = '', goModCache = '' }) {
  const env = { SCRIPT_SERVICE_TOKEN: token };
  const gatewayEnv = {
    ...env,
    AUTH_MODE: authMode,
    ...(agentComposeURL ? { AGENT_COMPOSE_URL: agentComposeURL } : {}),
    ...(scriptServiceURL ? { SCRIPT_SERVICE_URL: scriptServiceURL } : {}),
    ...(goCache ? { GOCACHE: goCache } : {}),
    ...(goModCache ? { GOMODCACHE: goModCache } : {}),
    ...(agentComposeDBPath && uiStateDBPath ? {
      AGENT_COMPOSE_DB_PATH: agentComposeDBPath,
      UI_STATE_DB_PATH: uiStateDBPath,
    } : {}),
  };
  return [
    { name: 'gateway', command: gatewayExecutable, args: ['run', './cmd/agent-compose-ui-server'], env: gatewayEnv },
    { name: 'web', command: executable, args: ['run', 'dev:web'], env },
    { name: 'scripts', command: executable, args: ['run', 'dev:scripts'], env },
  ];
}

async function startDevelopment() {
  const executable = process.execPath;
  const token = randomBytes(32).toString('hex');
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workspaceGo = path.resolve(projectRoot, '../.tools/go/bin/go');
  const specs = childSpecs({
    executable,
    gatewayExecutable: process.env.GO_EXECUTABLE || (existsSync(workspaceGo) ? workspaceGo : 'go'),
    token,
    authMode: process.env.AUTH_MODE,
    agentComposeURL: process.env.AGENT_COMPOSE_URL || 'http://127.0.0.1:7410',
    scriptServiceURL: process.env.SCRIPT_SERVICE_URL || 'http://127.0.0.1:7420',
    agentComposeDBPath: process.env.AGENT_COMPOSE_DB_PATH || path.resolve(projectRoot, '../agent-compose/.dev-data/data.db'),
    uiStateDBPath: process.env.UI_STATE_DB_PATH || path.resolve(projectRoot, '.cache/project-env.db'),
    goCache: process.env.GOCACHE || path.resolve(projectRoot, '.cache/go-build'),
    goModCache: process.env.GOMODCACHE || path.resolve(projectRoot, '../agent-compose/.cache/go-mod'),
  });

  const children = specs.map((spec) => {
    const child = spawn(spec.command, spec.args, {
      stdio: 'inherit',
      env: { ...process.env, ...spec.env },
      cwd: projectRoot,
    });
    child.on('exit', (code, signal) => {
      for (const other of children) {
        if (other !== child && other.exitCode === null && !other.killed) {
          other.kill('SIGTERM');
        }
      }
      if (code !== 0) {
        process.exit(code ?? 1);
      }
    });
    return child;
  });

  const shutdown = (signal) => {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill(signal);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(signal));
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) startDevelopment();
