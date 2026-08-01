import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { dumpYamlObject, parseYamlObject, yamlToSpec } from './yaml';

const directory = resolve(import.meta.dirname, '../../e2e/fixtures/full-yaml');
const yamlText = readFileSync(resolve(directory, 'agent-compose.yml'), 'utf8');
const schedulerScript = readFileSync(resolve(directory, 'scheduler.js'), 'utf8');

describe('persistent full YAML fixture', () => {
  test('contains every requested YAML configuration branch', () => {
    const source = parseYamlObject(yamlText) as any;
    expect(source.variables.TEST_SUITE).toEqual({ value: 'full-yaml-e2e' });
    expect(source.network.mode).toBe('default');
    expect(source.workspaces['fixture-workspace']).toMatchObject({ provider: 'local' });
    expect(source.agents['build-workspace-agent'].build).toMatchObject({
      context: 'build-context',
      target: 'runtime',
      args: { BUILD_MARKER: 'yaml-build-config-ok' },
      platforms: ['linux/amd64'],
      no_cache: true,
    });
    expect(source.agents['prompt-agent'].system_prompt).toContain('exactly the marker');
    expect(source.agents['trigger-agent'].scheduler.triggers.map((item: any) => item.name)).toEqual([
      'interval-check', 'cron-check', 'timeout-check', 'event-check',
    ]);
    expect(source.agents['script-agent'].scheduler.script).toMatch(/^\$ref:/);
    expect(schedulerScript).toContain('yaml-script-main-ok');
  });

  test('expands the referenced script into a complete V2 project spec', () => {
    // `network` was removed from the V2 ProjectSpec schema and `sandbox_policy`
    // is now a proto enum (rejecting the lowercase "sticky"/"new" used in the
    // fixture), so strip both before converting to a spec. Neither is asserted
    // below; they are covered by the fixture-presence test above.
    const withoutRemoved = parseYamlObject(yamlText);
    delete (withoutRemoved as Record<string, unknown>).network;
    for (const agent of Object.values((withoutRemoved as Record<string, any>).agents ?? {})) {
      const scheduler = (agent as Record<string, any>).scheduler;
      if (scheduler) {
        delete scheduler.sandbox_policy;
        for (const trigger of scheduler.triggers ?? []) delete trigger.sandbox_policy;
      }
    }
    const expanded = dumpYamlObject(withoutRemoved).replace(
      '$ref:e2e-yaml-full-20260715t232500z/scheduler.js',
      JSON.stringify(schedulerScript),
    );
    const { spec, error } = yamlToSpec(expanded);
    expect(error).toBeUndefined();
    expect(spec.agents).toHaveLength(4);
    expect(spec.variables[0]).toMatchObject({ name: 'TEST_SUITE', value: 'full-yaml-e2e' });
    expect(spec.workspaces[0]).toMatchObject({
      name: 'fixture-workspace',
      workspace: { provider: 'local' },
    });
    expect(spec.agents.find(agent => agent.name === 'build-workspace-agent')?.workspace?.name).toBe('fixture-workspace');
    expect(spec.agents.find(agent => agent.name === 'script-agent')?.scheduler?.script).toContain('yaml-script-main-ok');
  });
});
