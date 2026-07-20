import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function childSpecs({ executable, token, authMode = 'disabled' }) {
  const env = { SCRIPT_SERVICE_TOKEN: token };
  return [
    { name: 'gateway', command: 'go', args: ['run', './cmd/agent-compose-ui-server'], env: { ...env, AUTH_MODE: authMode } },
    { name: 'web', command: executable, args: ['run', 'dev:web'], env },
    { name: 'scripts', command: executable, args: ['run', 'dev:scripts'], env },
  ];
}

async function startDevelopment() {
  const executable = process.execPath;
  const token = randomBytes(32).toString('hex');
  const specs = childSpecs({ executable, token, authMode: process.env.AUTH_MODE });

  const children = specs.map((spec) => {
    const child = spawn(spec.command, spec.args, {
      stdio: 'inherit',
      env: { ...process.env, ...spec.env },
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
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
