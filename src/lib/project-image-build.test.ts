import { describe, expect, test } from 'vitest';
import { ImageOperationStatus, ProjectSpec } from '../gen/agentcompose/v2/agentcompose_pb';
import { yamlToSpec } from './yaml';
import {
  changedBuildAgentNames,
  createProjectImageBuildPlans,
  runProjectImageBuildPlans,
} from './project-image-build';

function project(yaml: string): ProjectSpec {
  const parsed = yamlToSpec(yaml);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.spec;
}

describe('changedBuildAgentNames', () => {
  const saved = project(`name: demo
agents:
  reviewer:
    image: reviewer:dev
    build:
      context: ./reviewer
      dockerfile: Dockerfile.agent
      target: runtime
      args:
        MODE: production
        CACHE: enabled
      platforms: [linux/amd64]
      tags: [reviewer:latest]
      no_cache: false
      pull: false
  removed:
    image: removed:dev
    build: { context: ./removed }
`);

  test('treats current build plans as changed when no saved project exists', () => {
    expect(changedBuildAgentNames(undefined, saved)).toEqual(new Set(['reviewer', 'removed']));
  });

  test('ignores unchanged builds and build argument insertion order', () => {
    const current = project(`name: demo
agents:
  reviewer:
    image: reviewer:dev
    build:
      context: ./reviewer
      dockerfile: Dockerfile.agent
      target: runtime
      args:
        CACHE: enabled
        MODE: production
      platforms: [linux/amd64]
      tags: [reviewer:latest]
      no_cache: false
      pull: false
  removed:
    image: removed:dev
    build: { context: ./removed }
`);

    expect(changedBuildAgentNames(saved, current)).toEqual(new Set());
  });

  test('detects modified and newly added builds but excludes removed builds', () => {
    const current = project(`name: demo
agents:
  reviewer:
    image: reviewer:dev
    build:
      context: ./reviewer
      dockerfile: Dockerfile.agent
      target: runtime
      args:
        MODE: development
        CACHE: enabled
      platforms: [linux/amd64]
      tags: [reviewer:latest]
  writer:
    image: writer:dev
    build: { context: ./writer }
  removed:
    image: removed:dev
`);

    expect(changedBuildAgentNames(saved, current)).toEqual(new Set(['reviewer', 'writer']));
  });
});

describe('createProjectImageBuildPlans', () => {
  test('maps YAML build config using CLI-compatible defaults and tag merging', () => {
    const plans = createProjectImageBuildPlans(project(`name: demo
agents:
  reviewer:
    image: reviewer:dev
    build:
      context: ./reviewer
      dockerfile: Dockerfile.agent
      target: runtime
      args:
        MODE: production
      platforms: [linux/amd64]
      tags: [reviewer:latest, reviewer:dev]
      no_cache: true
      pull: true
  remote:
    image: example/remote:latest
`), '/srv/demo/agent-compose.yml');

    expect(plans).toHaveLength(1);
    expect(plans[0].agentName).toBe('reviewer');
    expect(plans[0].request).toMatchObject({
      contextDir: '/srv/demo/reviewer',
      dockerfile: 'Dockerfile.agent',
      tags: ['reviewer:dev', 'reviewer:latest'],
      buildArgs: { MODE: 'production' },
      target: 'runtime',
      noCache: true,
      pull: true,
    });
    expect(plans[0].request?.platform).toMatchObject({ os: 'linux', architecture: 'amd64', variant: '' });
    expect(plans[0].error).toBe('');
  });

  test('defaults context and Dockerfile and reports invalid build plans without hiding them', () => {
    const plans = createProjectImageBuildPlans(project(`name: demo
agents:
  missing-tag:
    build: {}
  multi-platform:
    image: multi:dev
    build:
      platforms: [linux/amd64, linux/arm64]
`), '/srv/demo/agent-compose.yml');

    expect(plans).toHaveLength(2);
    expect(plans[0].request).toBeUndefined();
    expect(plans[0].error).toContain('image 或 build.tags');
    expect(plans[1].request).toBeUndefined();
    expect(plans[1].error).toContain('仅支持一个构建平台');
  });

  test('requires a daemon compose source path before resolving relative contexts', () => {
    const [plan] = createProjectImageBuildPlans(project(`name: demo
agents:
  reviewer:
    image: reviewer:dev
    build:
      context: ./reviewer
`), 'agent-compose.yml');

    expect(plan.request).toBeUndefined();
    expect(plan.error).toContain('daemon 来源路径');
  });
});

describe('runProjectImageBuildPlans', () => {
  test('runs selected plans serially, applies transient flags, and publishes stream state', async () => {
    const plans = createProjectImageBuildPlans(project(`name: demo
agents:
  first:
    image: first:dev
    build: { context: ./first }
  second:
    image: second:dev
    build: { context: ./second }
`), '/srv/demo/agent-compose.yml');
    const calls: string[] = [];
    const updates: string[] = [];
    const client = {
      buildImage(request: { tags: string[]; noCache: boolean; pull: boolean }) {
        calls.push(request.tags[0]);
        expect(request.noCache).toBe(true);
        expect(request.pull).toBe(true);
        return (async function* () {
          yield { status: ImageOperationStatus.RUNNING, stage: 'build', message: `building ${request.tags[0]}` };
          yield { status: ImageOperationStatus.SUCCEEDED, imageRef: request.tags[0] };
        })();
      },
    };

    const results = await runProjectImageBuildPlans({
      plans,
      selectedAgentNames: new Set(['first', 'second']),
      client,
      forceNoCache: true,
      forcePull: true,
      onUpdate: (result) => updates.push(`${result.agentName}:${result.status}:${result.stream.lines.length}`),
    });

    expect(calls).toEqual(['first:dev', 'second:dev']);
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
    expect(updates).toContain('first:building:1');
    expect(updates.at(-1)).toBe('second:succeeded:1');
  });

  test('stops after the first failed build and marks later plans unexecuted', async () => {
    const plans = createProjectImageBuildPlans(project(`name: demo
agents:
  first:
    image: first:dev
    build: { context: ./first }
  second:
    image: second:dev
    build: { context: ./second }
`), '/srv/demo/agent-compose.yml');
    const calls: string[] = [];

    await expect(runProjectImageBuildPlans({
      plans,
      selectedAgentNames: new Set(['first', 'second']),
      client: {
        buildImage(request: { tags: string[] }) {
          calls.push(request.tags[0]);
          return (async function* () {
            yield { status: ImageOperationStatus.FAILED, message: 'compile failed' };
          })();
        },
      },
      onUpdate: () => {},
    })).rejects.toMatchObject({ results: [
      { agentName: 'first', status: 'failed' },
      { agentName: 'second', status: 'unexecuted' },
    ] });
    expect(calls).toEqual(['first:dev']);
  });
});
