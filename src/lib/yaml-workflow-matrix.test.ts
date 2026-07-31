import { describe, expect, test } from 'vitest';
import { ProjectChangeAction } from '../gen/agentcompose/v2/agentcompose_pb';
import { complexYaml, invalidYamlInputs, minimalYaml } from '../../test/fixtures/yaml-workflow-scenarios';
import { createProjectImageBuildPlans } from './project-image-build';
import { previewProject, saveProject } from './toolbar-actions';
import { specToYaml, yamlToSpec } from './yaml';

describe('YAML input and expected model matrix', () => {
  test('parses a minimal project without inventing Agents', () => {
    const result = yamlToSpec(minimalYaml);
    expect(result.error).toBeUndefined();
    expect(result.spec.name).toBe('minimal-app');
    expect(result.spec.agents).toEqual([]);
  });

  test('parses Unicode, Agent order, environment, Scheduler, and build data', () => {
    const result = yamlToSpec(complexYaml);
    expect(result.error).toBeUndefined();
    expect(result.spec.name).toBe('深度测试-app');
    expect(result.spec.agents.map(agent => agent.name)).toEqual(['reviewer', 'scheduled', 'plain']);
    expect(result.spec.agents[0]).toMatchObject({
      provider: 'codex', model: 'gpt-test', systemPrompt: '严格审查输入并输出结论', image: 'reviewer:dev',
    });
    expect(result.spec.agents[0].env.map(item => [item.name, item.value])).toEqual([['MODE', 'test'], ['EMPTY', '']]);
    expect(result.spec.agents[1].scheduler).toMatchObject({ enabled: true, script: 'export default { triggers: [] }' });

    const [plan] = createProjectImageBuildPlans(result.spec, '/srv/deep/agent-compose.yml');
    expect(plan).toMatchObject({ agentName: 'reviewer', error: '', contextDisplay: './reviewer' });
    expect(plan.request).toMatchObject({
      contextDir: '/srv/deep/reviewer', dockerfile: 'Dockerfile.agent', target: 'runtime',
      tags: ['reviewer:dev', 'reviewer:latest'], buildArgs: { MODE: 'production' },
    });
  });

  test('round-trips the complex YAML without changing semantic fields', () => {
    const first = yamlToSpec(complexYaml);
    const second = yamlToSpec(specToYaml(first.spec));
    expect(second.error).toBeUndefined();
    expect(second.spec.toJson()).toEqual(first.spec.toJson());
  });

  for (const scenario of invalidYamlInputs) {
    test(`rejects ${scenario.name}`, () => {
      const result = yamlToSpec(scenario.yaml);
      expect(result.error).toBeTruthy();
      expect(result.spec.name).toBe('');
    });
  }
});

describe('YAML preview and Apply response matrix', () => {
  test('same hash produces zero real changes while preserving 13 resource details', async () => {
    const response = {
      applied: false, unchanged: false, revision: { specHash: 'same' },
      changes: Array.from({ length: 13 }, (_, index) => ({ action: ProjectChangeAction.CREATED, name: `resource-${index}` })),
    };
    const preview = await previewProject(complexYaml, { applyProject: async () => response as any }, {
      currentProjectId: 'project-1', expectedSpecHash: 'same',
      projects: [{ summary: { projectId: 'project-1', name: '深度测试-app', sourcePath: '/srv/deep/agent-compose.yml', specHash: 'same' } }],
    });
    expect(preview.response.unchanged).toBe(true);
    expect(preview.response.changes).toHaveLength(13);
    expect(preview.response.changes.filter(change => change.action !== ProjectChangeAction.UNCHANGED)).toEqual([]);
  });

  test('changed hash keeps changes and applies with the preview revision hash', async () => {
    const requests: any[] = [];
    const preview = await previewProject(complexYaml, { applyProject: async (request) => {
      requests.push(request);
      return request.dryRun
        ? { applied: false, unchanged: false, revision: { specHash: 'new' }, changes: [{ action: ProjectChangeAction.CREATED, name: 'reviewer' }] } as any
        : { applied: true, unchanged: false, project: { summary: { projectId: 'project-1' } }, changes: [] } as any;
    } }, {
      currentProjectId: 'project-1', expectedSpecHash: 'old',
      projects: [{ summary: { projectId: 'project-1', name: '深度测试-app', sourcePath: '/srv/deep/agent-compose.yml', specHash: 'old' } }],
    });
    expect(preview.response.unchanged).toBe(false);
    expect(preview.response.changes[0].action).toBe(ProjectChangeAction.CREATED);
    await preview.apply();
    expect(requests.map(request => [request.dryRun, request.expectedSpecHash])).toEqual([[true, ''], [false, 'new']]);
    expect(requests[1].spec.toJson()).toEqual(requests[0].spec.toJson());
  });

  test('invalid YAML and duplicate names issue no Apply request', async () => {
    let calls = 0;
    const client = { applyProject: async () => { calls++; return { applied: true } as any; } };
    await expect(saveProject('name: [', client)).rejects.toThrow('YAML 解析错误');
    await expect(saveProject(complexYaml, client, {
      currentProjectId: 'current', projects: [
        { summary: { projectId: 'current', name: 'old' } },
        { summary: { projectId: 'other', name: '深度测试-app' } },
      ],
    })).rejects.toThrow('已存在');
    expect(calls).toBe(0);
  });

  test('a rejected Apply response produces the exact save failure', async () => {
    await expect(saveProject(minimalYaml, { applyProject: async () => ({ applied: false, unchanged: false } as any) }))
      .rejects.toThrow('保存未生效');
  });
});
