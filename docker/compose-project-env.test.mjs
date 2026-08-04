import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const full = readFileSync(new URL('./docker-compose.full.yml', import.meta.url), 'utf8');
const external = readFileSync(new URL('./docker-compose.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
const allInOneNames = ['docker-compose.all-in-one.yml', 'Dockerfile.all-in-one'];
const fullWeb = full.slice(full.indexOf('  web:'), full.indexOf('\n  agent-compose:'));

describe('server-side project environment deployment', () => {
  test('full stack gives the gateway read-only daemon data and separate writable UI state', () => {
    expect(full).toContain('AGENT_COMPOSE_DB_PATH: /data/agent-compose/data.db');
    expect(full).toContain('UI_STATE_DB_PATH: /data/ui/project-env.db');
    expect(full).toMatch(/AGENT_COMPOSE_DATA_DIR[^\n]*:\/data\/agent-compose:ro/);
    expect(full).toContain('ui-state:/data/ui');
    expect(full).toMatch(/127\.0\.0\.1:\$\{AGENT_COMPOSE_PORT:-7410\}:7410/);
  });

  test('external daemon mode does not enable resolution without an explicit deployment override', () => {
    expect(external).not.toContain('AGENT_COMPOSE_DB_PATH:');
    expect(external).not.toContain('/data/agent-compose');
  });

  test('gateway build copies the module checksum before downloading dependencies', () => {
    expect(dockerfile).toMatch(/COPY go\.mod go\.sum \.\//);
  });

  test('both stacks persist tokens and expose the fixed container API port', () => {
    for (const compose of [full, external]) {
      expect(compose).toContain('TOKEN_DB_PATH: /data/api/tokens.db');
      expect(compose).toContain('${TOKEN_RBAC_API_PORT:-8081}:8081');
      expect(compose).toContain('api-token-data:/data/api');
    }
    expect(dockerfile).toContain('EXPOSE 80 8081');
  });

  test('both deployment modes mount project storage at the canonical container path', () => {
    expect(full).toContain('PROJECT_STORAGE_ROOT: /data/work/projects');
    expect(full.match(/:\/data\/work/g)?.length).toBeGreaterThanOrEqual(2);
    expect(external).toContain('PROJECT_STORAGE_ROOT: /data/work/projects');
    expect(external).toMatch(/PROJECT_WORK_DIR[^\n]*:\/data\/work/);
  });

  test('full stack gives only the UI a narrow writable local-volume root', () => {
    expect(full).toContain('LOCAL_VOLUME_ROOT: /data/volumes/local');
    expect(full).toContain('${AGENT_COMPOSE_DATA_DIR:-./data}/volumes/local:/data/volumes/local');
    expect(full).not.toContain('${AGENT_COMPOSE_DATA_DIR:-./data}/volumes/local:/data/volumes/local:ro');
    expect(fullWeb).not.toMatch(/AGENT_COMPOSE_DATA_DIR[^\n]*:\/data(?:\s|$)/m);
    expect(full).toMatch(/AGENT_COMPOSE_DATA_DIR[^\n]*:\/data\/agent-compose:ro/);
    expect(full).toContain('${AGENT_COMPOSE_DATA_DIR:-./data}/work:/data/work');
  });

  test('local-volume deployment does not depend on all-in-one files', () => {
    for (const name of allInOneNames) expect(full).not.toContain(name);
  });
});
