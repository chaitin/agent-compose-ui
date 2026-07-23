import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const config = readFileSync(
  new URL('./default.conf.template', import.meta.url),
  'utf8',
);

describe('nginx gateway boundary', () => {
  test('routes every backend-facing path to the loopback gateway', () => {
    expect(config).toMatch(/location.*agentcompose/);
    expect(config).toMatch(/location \/script-api\//);
    expect(config).toMatch(/location \/ui-api\//);
    expect(config).toMatch(/agentcompose\\\.v\[12\]/);
    expect(config).toMatch(/health\\\.v1/);
    expect(config).toMatch(/api\//);
    expect(config).toMatch(/oauth\//);
    expect(config).toContain('agent-compose/session/');
    expect(config).toMatch(/jupyter/);
    expect(config.match(/proxy_pass http:\/\/127\.0\.0\.1:8080/g)?.length).toBe(3);
  });

  test('forwards the external protocol and leaves script credentials to Go', () => {
    expect(config).toContain('X-Forwarded-Proto $scheme');
    expect(config).not.toContain('X-Script-Service-Token ${SCRIPT_SERVICE_TOKEN}');
  });

  test('preserves websocket upgrades through the gateway proxy', () => {
    expect(config).toMatch(/map \$http_upgrade \$connection_upgrade\s*{[^}]*default upgrade;[^}]*'' close;/s);
    expect(config).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(config).toContain('proxy_set_header Connection $connection_upgrade;');
  });
});
