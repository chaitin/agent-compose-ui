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
    expect(config).toMatch(/agentcompose\\\.v\[12\]/);
    expect(config).toMatch(/health\\\.v1/);
    expect(config).toMatch(/api\//);
    expect(config).toMatch(/oauth\//);
    expect(config).toContain('agent-compose/session/');
    expect(config).toMatch(/jupyter/);
    expect(config.match(/proxy_pass http:\/\/127\.0\.0\.1:8080/g)?.length).toBe(2);
  });

  test('forwards the external protocol and leaves script credentials to Go', () => {
    expect(config).toContain('X-Forwarded-Proto $scheme');
    expect(config).not.toContain('X-Script-Service-Token ${SCRIPT_SERVICE_TOKEN}');
  });
});
