import { describe, expect, test } from 'bun:test';
import { ProjectChangeAction, RunSource, RunStatus, SchedulerRunStatus, StartRunRequest } from '../gen/agentcompose/v2/agentcompose_pb';
import {
  cascadeDeleteProject,
  deleteProject,
  getAppliedProjectId,
  runProjectAgents,
  runProjectAgentsIfCurrent,
  runYamlBatch,
  previewProject,
  prepareProjectPreview,
  consumePendingApply,
  createPreviewGeneration,
  saveProject,
  probeProjectRuntimeActivity,
  softPauseProject,
  stopProjectRuns,
} from './toolbar-actions';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferredStream() {
  const values = [];
  const waiters = [];
  let closed = false;
  return {
    push(value) {
      const resolve = waiters.shift();
      if (resolve) resolve({ value, done: false });
      else values.push(value);
    },
    close() {
      closed = true;
      for (const resolve of waiters.splice(0)) resolve({ done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (values.length) return Promise.resolve({ value: values.shift(), done: false });
        if (closed) return Promise.resolve({ done: true });
        return new Promise((resolve) => waiters.push(resolve));
      },
    },
  };
}

async function* streamOf(...chunks) {
  yield* chunks;
}

function runDetails(finalStatus = RunStatus.SUCCEEDED) {
  const calls = new Map();
  return async (request) => {
    const count = calls.get(request.runId) ?? 0;
    calls.set(request.runId, count + 1);
    return { run: { summary: { runId: request.runId, status: count === 0 ? RunStatus.RUNNING : finalStatus } } };
  };
}

describe('runYamlBatch', () => {
  const agents = [{ name: 'a', prompt: 'A' }, { name: 'b', prompt: 'B' }];
  const callbacks = (events) => ({
    onStarting: (name) => events.push(`starting:${name}`),
    onStarted: (name, run) => events.push(`started:${name}:${run.runId}`),
    onChunk: (name, chunk) => events.push(`chunk:${name}:${chunk.data}`),
    onFinished: (name, status) => events.push(`finished:${name}:${status}`),
    onStartFailed: (name) => events.push(`failed:${name}`),
    onTrackingError: (name) => events.push(`tracking-error:${name}`),
  });

  test('starts the next agent only after the previous log stream is final', async () => {
    const events = [];
    const first = deferredStream();
    const client = {
      startRun: async ({ run }) => ({ started: true, run: { runId: `run-${run.agentName}`, status: RunStatus.PENDING } }),
      followRunLogs: ({ runId }) => runId === 'run-a'
        ? first.iterable
        : streamOf({ data: 'B', offset: 1n, runStatus: RunStatus.SUCCEEDED, isFinal: true }),
      getRun: runDetails(),
    };
    const pending = runYamlBatch({ projectId: 'p1', agents, client, isCurrent: () => true, ...callbacks(events) });
    await tick();
    expect(events).toEqual(['starting:a', 'started:a:run-a']);
    first.push({ data: 'A', offset: 1n, runStatus: RunStatus.SUCCEEDED, isFinal: true });
    first.close();
    await pending;
    expect(events).toEqual([
      'starting:a', 'started:a:run-a', 'chunk:a:A', `finished:a:${RunStatus.SUCCEEDED}`,
      'starting:b', 'started:b:run-b', 'chunk:b:B', `finished:b:${RunStatus.SUCCEEDED}`,
    ]);
  });

  test('sends a generated StartRunRequest with the complete manual run input', async () => {
    const requests = [];
    await runYamlBatch({
      projectId: 'project-full', agents: [{ name: 'agent-full', prompt: 'prompt-full' }], isCurrent: () => true,
      ...callbacks([]),
      client: {
        startRun: async (request) => {
          requests.push(request);
          return { started: true, run: { runId: 'run-full' } };
        },
        followRunLogs: () => streamOf({ offset: 1n, isFinal: true, runStatus: RunStatus.SUCCEEDED }),
        getRun: runDetails(),
      },
    });
    expect(requests[0]).toBeInstanceOf(StartRunRequest);
    expect(requests[0].run).toMatchObject({
      projectId: 'project-full',
      agentName: 'agent-full',
      prompt: 'prompt-full',
      source: RunSource.MANUAL,
    });
  });

  test('uses non-empty response warnings when the run is not started', async () => {
    const errors = [];
    await runYamlBatch({
      projectId: 'p1', agents: [agents[0]], isCurrent: () => true,
      ...callbacks([]),
      onStartFailed: (_name, error) => errors.push(error),
      client: {
        startRun: async () => ({ started: false, warnings: ['', 'capacity exhausted', 'retry later'] }),
        followRunLogs: () => streamOf(),
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe('capacity exhausted; retry later');
  });

  test('uses the precise fallback when a started response omits its run ID', async () => {
    const errors = [];
    await runYamlBatch({
      projectId: 'p1', agents: [agents[0]], isCurrent: () => true,
      ...callbacks([]),
      onStartFailed: (_name, error) => errors.push(error),
      client: {
        startRun: async () => ({ started: true, run: {}, warnings: [] }),
        followRunLogs: () => streamOf(),
      },
    });
    expect(errors[0].message).toBe('运行未返回 Run ID');
  });

  test('treats a missing run ID as a start failure and continues', async () => {
    const events = [];
    await runYamlBatch({
      projectId: 'p1', agents, isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async ({ run }) => run.agentName === 'a' ? { started: true } : { started: true, run: { runId: 'run-b' } },
        followRunLogs: () => streamOf({ data: '', offset: 1n, isFinal: true, runStatus: RunStatus.SUCCEEDED }),
        getRun: runDetails(),
      },
    });
    expect(events).toEqual(['starting:a', 'failed:a', 'starting:b', 'started:b:run-b', 'chunk:b:', `finished:b:${RunStatus.SUCCEEDED}`]);
  });

  test('continues to the next agent when startRun rejects', async () => {
    const events = [];
    await runYamlBatch({
      projectId: 'p1', agents, isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async ({ run }) => {
          if (run.agentName === 'a') throw new Error('start unavailable');
          return { started: true, run: { runId: 'run-b' } };
        },
        followRunLogs: () => streamOf({ data: 'B', offset: 1n, isFinal: true, runStatus: RunStatus.SUCCEEDED }),
        getRun: async () => ({ run: { summary: { runId: 'run-b', status: RunStatus.SUCCEEDED } } }),
      },
    });
    expect(events).toContain('failed:a');
    expect(events).toContain('started:b:run-b');
  });

  test('abort and generation invalidation suppress old callbacks and later starts', async () => {
    for (const invalidate of ['abort', 'generation']) {
      const events = [];
      const first = deferredStream();
      const controller = new AbortController();
      let current = true;
      const pending = runYamlBatch({
        projectId: 'p1', agents, signal: controller.signal, isCurrent: () => current, ...callbacks(events),
        client: {
          startRun: async () => ({ started: true, run: { runId: 'run-a' } }),
        followRunLogs: () => first.iterable,
          getRun: runDetails(),
        },
      });
      await tick();
      if (invalidate === 'abort') controller.abort();
      else current = false;
      first.push({ data: 'stale', offset: 1n, isFinal: true });
      first.close();
      await pending;
      expect(events).toEqual(['starting:a', 'started:a:run-a']);
    }
  });

  test('propagates the exact start offset and suppresses duplicate chunks', async () => {
    const events = [];
    const requests = [];
    await runYamlBatch({
      projectId: 'p1', agents: [agents[0]], startOffset: 7n, isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async () => ({ started: true, run: { runId: 'run-a' } }),
        followRunLogs: (request) => {
          requests.push(request);
          return streamOf(
            { data: 'duplicate', offset: 7n, isFinal: false },
            { data: 'new', offset: 8n, isFinal: true },
          );
        },
        getRun: runDetails(),
      },
    });
    expect(requests[0].startOffset).toBe(7n);
    expect(events.filter((event) => event.startsWith('chunk:'))).toEqual(['chunk:a:', 'chunk:a:new']);
  });

  test('delivers terminal status even when final chunk has duplicate offset zero', async () => {
    for (const status of [RunStatus.FAILED, RunStatus.CANCELED]) {
      const chunks = [];
      const finished = [];
      await runYamlBatch({
        projectId: 'p1', agents: [agents[0]], isCurrent: () => true,
        ...callbacks([]),
        onChunk: (_name, chunk) => chunks.push(chunk),
        onFinished: (_name, status) => finished.push(status),
        client: {
          startRun: async () => ({ started: true, run: { runId: 'run-a', status: RunStatus.RUNNING } }),
          getRun: runDetails(status),
          followRunLogs: () => streamOf({ data: '', offset: 0n, runStatus: status, isFinal: true }),
        },
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].runStatus).toBe(status);
      expect(finished).toEqual([status]);
    }
  });

  test('reconciles a naturally ended stream before starting the next agent', async () => {
    const events = [];
    await runYamlBatch({
      projectId: 'p1', agents, isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async ({ run }) => ({ started: true, run: { runId: `run-${run.agentName}` } }),
        getRun: runDetails(),
        followRunLogs: () => streamOf({ data: 'last', offset: 1n, runStatus: RunStatus.SUCCEEDED, isFinal: false }),
      },
    });
    expect(events.filter(event => event.startsWith('finished:'))).toEqual([
      `finished:a:${RunStatus.SUCCEEDED}`, `finished:b:${RunStatus.SUCCEEDED}`,
    ]);
  });

  test('follows logs when the initial GetRun is temporarily unavailable', async () => {
    const events = [];
    let getCalls = 0;
    await runYamlBatch({
      projectId: 'p1', agents: [agents[0]], isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async () => ({ started: true, run: { runId: 'run-a', status: RunStatus.PENDING } }),
        getRun: async () => {
          if (getCalls++ === 0) throw new Error('not visible yet');
          return { run: { summary: { runId: 'run-a', status: RunStatus.SUCCEEDED } } };
        },
        followRunLogs: () => streamOf({ data: 'done', offset: 1n, runStatus: RunStatus.SUCCEEDED, isFinal: true }),
      },
    });
    expect(events).toContain('chunk:a:done');
    expect(events).toContain(`finished:a:${RunStatus.SUCCEEDED}`);
  });

  test('uses a terminal final chunk when final GetRun fails and continues', async () => {
    const events = [];
    let getCalls = 0;
    await runYamlBatch({
      projectId: 'p1', agents, isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async ({ run }) => ({ started: true, run: { runId: `run-${run.agentName}`, status: RunStatus.RUNNING } }),
        getRun: async (request) => {
          if (getCalls++ % 2 === 0) return { run: { summary: { runId: request.runId, status: RunStatus.RUNNING } } };
          throw new Error('final unavailable');
        },
        followRunLogs: () => streamOf({ offset: 0n, runStatus: RunStatus.FAILED, isFinal: true }),
      },
    });
    expect(events.filter(event => event.startsWith('finished:'))).toEqual([
      `finished:a:${RunStatus.FAILED}`, `finished:b:${RunStatus.FAILED}`,
    ]);
    expect(events).not.toContain('tracking-error:a');
  });

  test('stops later agents when a nonterminal stream ends and final GetRun fails', async () => {
    const events = [];
    let calls = 0;
    await runYamlBatch({
      projectId: 'p1', agents, isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async ({ run }) => ({ started: true, run: { runId: `run-${run.agentName}`, status: RunStatus.RUNNING } }),
        getRun: async () => calls++ === 0
          ? { run: { summary: { runId: 'run-a', status: RunStatus.RUNNING } } }
          : Promise.reject(new Error('final unavailable')),
        followRunLogs: () => streamOf({ offset: 1n, runStatus: RunStatus.RUNNING, isFinal: false }),
      },
    });
    expect(events).toContain('tracking-error:a');
    expect(events).not.toContain('starting:b');
  });

  test('stops the batch when a tracked stream disconnects after start', async () => {
    const events = [];
    await runYamlBatch({
      projectId: 'p1', agents, isCurrent: () => true, ...callbacks(events),
      client: {
        startRun: async ({ run }) => ({ started: true, run: { runId: `run-${run.agentName}` } }),
        followRunLogs: async function* () { throw new Error('disconnected'); },
        getRun: runDetails(),
      },
    });
    expect(events).toEqual(['starting:a', 'started:a:run-a', 'tracking-error:a']);
  });
});

const validYaml = `name: demo
agents:
  alpha:
    system_prompt: You are alpha
  beta: {}
`;

describe('saveProject', () => {
  test('runs dependency preflight before dry-run Apply', async () => {
    const order = [];
    await prepareProjectPreview({
      mode: 'save',
      currentProjectId: '',
      editorContent: validYaml,
      projects: [],
      fallbackSpecHash: '',
      prepare: async () => { order.push('prepare'); return { yamlText: validYaml }; },
      preflight: async (prepared) => { order.push(`preflight:${prepared.yamlText.includes('name: demo')}`); },
      client: { applyProject: async () => { order.push('apply'); return { changes: [], revision: { specHash: 'hash' } }; } },
      isCurrent: () => true,
    });

    expect(order).toEqual(['prepare', 'preflight:true', 'apply']);
  });

  test('blocks dry-run Apply when dependency preflight rejects', async () => {
    let applyCalls = 0;
    await expect(prepareProjectPreview({
      mode: 'save',
      currentProjectId: '',
      editorContent: validYaml,
      projects: [],
      fallbackSpecHash: '',
      prepare: async () => ({ yamlText: validYaml }),
      preflight: async () => { throw new Error('镜像不存在'); },
      client: { applyProject: async () => { applyCalls += 1; return { changes: [] }; } },
      isCurrent: () => true,
    })).rejects.toThrow('镜像不存在');
    expect(applyCalls).toBe(0);
  });

  test('drops a deferred preview across an A to B to A switch during script preparation', async () => {
    let releasePrepare;
    let applyCalls = 0;
    const generation = createPreviewGeneration(() => {});
    const token = generation.begin();
    const preparing = prepareProjectPreview({
      mode: 'save',
      currentProjectId: 'project-a',
      editorContent: 'name: project-a\nagents: {}\n',
      projects: [{ summary: { projectId: 'project-a', name: 'project-a', sourcePath: '/a/agent-compose.yml', specHash: 'hash-a' } }],
      fallbackSpecHash: '',
      prepare: () => new Promise((resolve) => { releasePrepare = resolve; }),
      client: { applyProject: async () => { applyCalls++; return { changes: [] }; } },
      isCurrent: () => generation.isCurrent(token),
    });

    generation.invalidate(); // A -> B
    generation.invalidate(); // B -> A
    releasePrepare({ yamlText: 'name: project-a\nagents: {}\n', references: [] });

    expect(await preparing).toBeUndefined();
    expect(applyCalls).toBe(0);
  });

  test('permanently clears a published preview when context switches away and back', () => {
    const state = { pending: {}, changes: [{}], issues: [{}], unchanged: true, show: true };
    const generation = createPreviewGeneration(() => {
      state.pending = undefined; state.changes = []; state.issues = []; state.unchanged = false; state.show = false;
    });
    const token = generation.begin();
    generation.invalidate(); // A -> B clears
    generation.invalidate(); // B -> A must not revive
    expect(generation.isCurrent(token)).toBe(false);
    expect(state).toEqual({ pending: undefined, changes: [], issues: [], unchanged: false, show: false });
  });

  test('does not restore a failed apply after its generation switches', async () => {
    let restored;
    const generation = createPreviewGeneration(() => {});
    const token = generation.begin();
    const failed = { apply: async () => { generation.invalidate(); throw new Error('conflict'); } };
    let slot = failed;
    await expect(consumePendingApply({
      take: () => { const value = slot; slot = undefined; return value; },
      restore: (value) => { if (generation.isCurrent(token)) restored = value; },
    })).rejects.toThrow('conflict');
    expect(restored).toBeUndefined();
    expect(slot).toBeUndefined();
  });

  test('atomically consumes pending apply so double confirmation sends one RPC and restores on failure', async () => {
    let calls = 0;
    const pending = { apply: async () => { calls++; await Promise.resolve(); return 'ok'; } };
    let slot = pending;
    const access = { take: () => { const value = slot; slot = undefined; return value; }, restore: (value) => { slot = value; } };
    const [first, second] = await Promise.all([consumePendingApply(access), consumePendingApply(access)]);
    expect(first).toBe('ok');
    expect(second).toBeUndefined();
    expect(calls).toBe(1);

    const failed = { apply: async () => { throw new Error('conflict'); } };
    slot = failed;
    await expect(consumePendingApply(access)).rejects.toThrow('conflict');
    expect(slot).toBe(failed);
  });

  test('previews without a stale hash and applies with the normalized dry-run hash', async () => {
    const requests = [];
    const client = {
      applyProject: async (request) => {
        requests.push(request);
        return request.dryRun
          ? { applied: false, unchanged: false, changes: [{ name: 'alpha', action: ProjectChangeAction.CREATED }], issues: [], revision: { specHash: 'hash-after-edit' } }
          : { applied: true, unchanged: false, changes: [{ name: 'alpha' }] };
      },
    };
    const options = {
      currentProjectId: 'current',
      expectedSpecHash: 'hash-before-edit',
      projects: [{ summary: { projectId: 'current', name: 'demo', sourcePath: '/srv/demo/agent-compose.yml' } }],
    };

    const preview = await previewProject(validYaml, client, options);
    expect(requests).toHaveLength(1);
    expect(requests[0].dryRun).toBe(true);
    expect(requests[0].expectedSpecHash).toBe('');
    expect(requests[0].source.composePath).toBe('/srv/demo/agent-compose.yml');
    expect(preview.response.changes).toHaveLength(1);
    expect(preview.response.unchanged).toBe(false);
    expect(preview.response.changes[0].action).toBe(ProjectChangeAction.CREATED);

    await preview.apply();
    expect(requests).toHaveLength(2);
    expect(requests[1].dryRun).toBe(false);
    expect(requests[1].expectedSpecHash).toBe('hash-after-edit');
    expect(requests[1].source.composePath).toBe(requests[0].source.composePath);
    expect(requests[1].spec).toBe(requests[0].spec);
  });

  test('treats dry-run created resources as unchanged when the saved and preview hashes match', async () => {
    const response = {
      applied: false,
      unchanged: false,
      changes: Array.from({ length: 13 }, (_, index) => ({
        action: ProjectChangeAction.CREATED,
        resourceType: 'agent',
        name: `resource-${index + 1}`,
      })),
      revision: { specHash: 'same-hash' },
    };

    const preview = await previewProject(validYaml, {
      applyProject: async () => response,
    }, {
      currentProjectId: 'current',
      expectedSpecHash: 'same-hash',
      projects: [{ summary: { projectId: 'current', name: 'demo', specHash: 'same-hash' } }],
    });

    expect(preview.response).toBe(response);
    expect(preview.response.unchanged).toBe(true);
    expect(preview.response.changes).toHaveLength(13);
    expect(preview.response.changes.every((change) => change.action === ProjectChangeAction.UNCHANGED)).toBe(true);
  });

  test('parses and applies YAML and returns the applied agent names', async () => {
    const requests = [];
    const response = { applied: true, unchanged: false, changes: [] };

    const result = await saveProject(validYaml, {
      applyProject: async (request) => {
        requests.push(request);
        return response;
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].source.composePath).toBe('agent-compose.yml');
    expect(result.response).toBe(response);
    expect(result.agentNames).toEqual(['alpha', 'beta']);
    expect(result.agents).toEqual([
      { name: 'alpha', prompt: 'You are alpha', hasScheduler: false },
      { name: 'beta', prompt: '', hasScheduler: false },
    ]);
  });

  test('uses one caller-provided virtual source path for a new project preview and apply', async () => {
    const requests = [];
    const virtualPath = '/agent-compose-ui/projects/draft-1/agent-compose.yml';
    const preview = await previewProject(validYaml, {
      applyProject: async (request) => {
        requests.push(request);
        return request.dryRun
          ? { applied: false, unchanged: false, changes: [], issues: [], revision: { specHash: 'preview-hash' } }
          : { applied: true, unchanged: false, changes: [] };
      },
    }, {
      currentProjectId: '',
      projects: [],
      newProjectSourcePath: virtualPath,
    });

    await preview.apply();
    expect(requests.map((request) => request.source.composePath)).toEqual([virtualPath, virtualPath]);
  });

  test('source path override replaces an unmanaged saved-project path for preview and apply', async () => {
    const requests = [];
    const sharedPath = '/data/work/projects/ws_0123456789abcdef0123456789abcdef/agent-compose.yml';
    const preview = await previewProject(validYaml, {
      applyProject: async (request) => {
        requests.push(request);
        return request.dryRun
          ? { changes: [], issues: [], revision: { specHash: 'preview-hash' } }
          : { applied: true, changes: [] };
      },
    }, {
      currentProjectId: 'current',
      projects: [{ summary: { projectId: 'current', name: 'demo', sourcePath: '/legacy/agent-compose.yml' } }],
      sourcePathOverride: sharedPath,
    });
    await preview.apply();
    expect(requests.map((request) => request.source.composePath)).toEqual([sharedPath, sharedPath]);
  });

  test('marks agents that define a scheduler in the applied YAML', async () => {
    const result = await saveProject(`name: scheduled-demo
agents:
  scheduled:
    system_prompt: You are scheduled
    scheduler:
      enabled: false
      triggers: []
  manual: {}
`, {
      applyProject: async () => ({ applied: true }),
    });

    expect(result.agents).toEqual([
      { name: 'scheduled', prompt: 'You are scheduled', hasScheduler: true },
      { name: 'manual', prompt: '', hasScheduler: false },
    ]);
  });

  test('rejects invalid YAML without applying', async () => {
    let applyCalls = 0;

    await expect(saveProject('agents: [', {
      applyProject: async () => {
        applyCalls++;
        return { applied: true };
      },
    })).rejects.toThrow('YAML 解析错误');

    expect(applyCalls).toBe(0);
  });

  test('uses preparedYaml (expanded script) instead of editorContent ($ref) when applying', async () => {
    const requests = [];
    const editorYaml = `name: demo
agents:
  worker:
    scheduler:
      script: $ref:demo/a.js
`;
    const preparedYaml = `name: demo
agents:
  worker:
    scheduler:
      script: full-inline-code
`;

    await saveProject(editorYaml, {
      applyProject: async (request) => {
        requests.push(request);
        return { applied: true, unchanged: false, changes: [] };
      },
    }, {
      currentProjectId: '',
      projects: [],
      preparedYaml,
    });

    expect(requests).toHaveLength(1);
    const appliedScript = requests[0].spec.agents[0].scheduler?.script;
    expect(appliedScript).toBe('full-inline-code');
  });

  test('rejects a response that is neither applied nor unchanged', async () => {
    await expect(saveProject(validYaml, {
      applyProject: async () => ({ applied: false, unchanged: false }),
    })).rejects.toThrow('保存未生效');
  });

  test('rejects a duplicate new project before applying', async () => {
    let applyCalls = 0;

    await expect(saveProject(validYaml, {
      applyProject: async () => {
        applyCalls++;
        return { applied: true };
      },
    }, {
      currentProjectId: '',
      projects: [{ summary: { projectId: 'existing', name: ' demo ' } }],
    })).rejects.toThrow('智能体应用名称 "demo" 已存在，请修改名称');

    expect(applyCalls).toBe(0);
  });

  test('allows an existing project to keep its own name', async () => {
    let applyCalls = 0;

    await saveProject(validYaml, {
      applyProject: async () => {
        applyCalls++;
        return { applied: true };
      },
    }, {
      currentProjectId: 'current',
      projects: [{ summary: { projectId: 'current', name: 'demo' } }],
    });

    expect(applyCalls).toBe(1);
  });

  test('allows a legacy project ID to match its current list entry', async () => {
    const requests = [];
    const hash = '31ccba9d49e51ff2093b2a9ec7f69d6676f72a1e952569cf99c567007d19581f';

    await saveProject(validYaml, {
      applyProject: async (request) => {
        requests.push(request);
        return { applied: true };
      },
    }, {
      currentProjectId: `sha256:${hash}`,
      projects: [{
        summary: {
          projectId: hash,
          name: 'demo',
          sourcePath: '/projects/tech-radar/agent-compose.yml',
        },
      }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].source.composePath).toBe('/projects/tech-radar/agent-compose.yml');
  });

  test('uses the existing source path when saving the current project', async () => {
    const requests = [];

    await saveProject(validYaml, {
      applyProject: async (request) => {
        requests.push(request);
        return { applied: true };
      },
    }, {
      currentProjectId: 'current',
      projects: [{
        summary: {
          projectId: 'current',
          name: 'demo',
          sourcePath: '/projects/tech-radar/agent-compose.yml',
        },
      }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].source.composePath).toBe('/projects/tech-radar/agent-compose.yml');
  });

  test('identifies a legacy sha256 ID superseded by the applied project ID', async () => {
    const legacyId = 'sha256:31ccba9d49e51ff2093b2a9ec7f69d6676f72a1e952569cf99c567007d19581f';

    const result = await saveProject(validYaml, {
      applyProject: async () => ({
        applied: true,
        project: { summary: { projectId: legacyId.slice('sha256:'.length) } },
      }),
    }, {
      currentProjectId: legacyId,
      projects: [{ summary: { projectId: legacyId, name: 'demo' } }],
    });

    expect(result.supersededProjectId).toBe(legacyId);
  });

  test('does not supersede an unrelated current project ID', async () => {
    const result = await saveProject(validYaml, {
      applyProject: async () => ({
        applied: true,
        project: { summary: { projectId: 'different-project' } },
      }),
    }, {
      currentProjectId: 'current',
      projects: [{ summary: { projectId: 'current', name: 'demo' } }],
    });

    expect(result.supersededProjectId).toBe('');
  });

  test('rejects renaming an existing project to another project name', async () => {
    await expect(saveProject(validYaml, {
      applyProject: async () => ({ applied: true }),
    }, {
      currentProjectId: 'current',
      projects: [
        { summary: { projectId: 'current', name: 'old-name' } },
        { summary: { projectId: 'other', name: 'demo' } },
      ],
    })).rejects.toThrow('智能体应用名称 "demo" 已存在，请修改名称');
  });
});

describe('runProjectAgentsIfCurrent', () => {
  test('suppresses deferred old-project run side effects after A to B to A invalidation', async () => {
    let releaseRun;
    const effects = [];
    const generation = createPreviewGeneration(() => {});
    const token = generation.begin();
    const running = runProjectAgentsIfCurrent({
      projectId: 'project-a',
      agents: [{ name: 'alpha', prompt: '' }, { name: 'beta', prompt: '' }],
      client: { runAgent: () => new Promise((resolve) => { releaseRun = resolve; }) },
      isCurrent: () => generation.isCurrent(token),
      onNavigate: () => effects.push('navigate'),
      onStarted: (name) => effects.push(`started:${name}`),
      onFailed: (name) => effects.push(`failed:${name}`),
      onSettled: () => effects.push('refresh'),
    });
    expect(effects).toEqual(['navigate']);
    effects.length = 0;
    generation.invalidate(); // A -> B
    generation.invalidate(); // B -> A
    releaseRun({});
    await running;
    expect(effects).toEqual([]);
  });

  test('suppresses a deferred rejection from an invalid generation', async () => {
    let rejectRun;
    const effects = [];
    const generation = createPreviewGeneration(() => {});
    const token = generation.begin();
    const running = runProjectAgentsIfCurrent({
      projectId: 'project-a', agents: [{ name: 'alpha', prompt: '' }],
      client: { runAgent: () => new Promise((_, reject) => { rejectRun = reject; }) },
      isCurrent: () => generation.isCurrent(token),
      onNavigate: () => effects.push('navigate'), onStarted: () => effects.push('started'),
      onFailed: () => effects.push('failed'), onSettled: () => effects.push('refresh'),
    });
    effects.length = 0;
    generation.invalidate();
    rejectRun(new Error('old failure'));
    await running;
    expect(effects).toEqual([]);
  });
});
describe('deleteProject', () => {
  test('removes the selected project and stops its running sessions', async () => {
    const requests = [];

    await deleteProject('project-1', {
      removeProject: async (request) => { requests.push(request); },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].project.projectId).toBe('project-1');
    expect(requests[0].stopRunningSandboxes).toBe(true);
    expect(requests[0].removeHistory).toBe(false);
  });

  test('can remove a superseded project without stopping shared running sessions', async () => {
    const requests = [];

    await deleteProject('legacy-project', {
      removeProject: async (request) => { requests.push(request); },
    }, { stopRunningSessions: false });

    expect(requests).toHaveLength(1);
    expect(requests[0].stopRunningSandboxes).toBe(false);
  });
});

describe('cascadeDeleteProject', () => {
  test('removes every related sandbox before soft-deleting the project while preserving history', async () => {
    const calls = [];
    const result = await cascadeDeleteProject('project-1', {
      listSandboxes: async ({ cursor }) => cursor === ''
        ? { sandboxes: [
            { sandboxId: 'direct', projectId: 'project-1', tags: [] },
            { sandboxId: 'other', projectId: 'project-2', tags: [] },
          ], nextCursor: 'page-2' }
        : { sandboxes: [
            { sandboxId: 'tagged', projectId: '', tags: [{ name: 'project', value: 'project-1' }] },
          ], nextCursor: '' },
      removeSandbox: async (request) => {
        calls.push(['sandbox', request.sandboxId, request.force]);
        return { sandboxId: request.sandboxId, removed: true };
      },
      removeProject: async (request) => {
        calls.push(['project', request.removeHistory, request.stopRunningSandboxes]);
        return {};
      },
    });
    expect(calls).toEqual([
      ['sandbox', 'direct', true],
      ['sandbox', 'tagged', true],
      ['project', false, true],
    ]);
    expect(result).toEqual({ removedSandboxes: 2 });
  });

  test.each([
    ['missing id', { sandboxId: '', projectId: 'project-1' }],
    ['removed false', { sandboxId: 's1', projectId: 'project-1' }],
  ])('%s aborts before project removal', async (name, sandbox) => {
    let projectCalls = 0;
    await expect(cascadeDeleteProject('project-1', {
      listSandboxes: async () => ({ sandboxes: [sandbox], nextCursor: '' }),
      removeSandbox: async ({ sandboxId }) => ({ sandboxId, removed: name !== 'removed false' }),
      removeProject: async () => { projectCalls += 1; return {}; },
    })).rejects.toThrow();
    expect(projectCalls).toBe(0);
  });

  test('removeSandbox failure aborts before project removal', async () => {
    let projectCalls = 0;
    await expect(cascadeDeleteProject('project-1', {
      listSandboxes: async () => ({ sandboxes: [{ sandboxId: 's1', projectId: 'project-1' }], nextCursor: '' }),
      removeSandbox: async () => { throw new Error('sandbox cleanup failed'); },
      removeProject: async () => { projectCalls += 1; return {}; },
    })).rejects.toThrow('sandbox cleanup failed');
    expect(projectCalls).toBe(0);
  });

  test('repeated list cursor aborts before project removal', async () => {
    let projectCalls = 0;
    await expect(cascadeDeleteProject('project-1', {
      listSandboxes: async () => ({ sandboxes: [], nextCursor: 'same-page' }),
      removeSandbox: async () => ({ removed: true }),
      removeProject: async () => { projectCalls += 1; return {}; },
    })).rejects.toThrow('ListSandboxes returned repeated cursor: same-page');
    expect(projectCalls).toBe(0);
  });

  test('matches legacy sha256 project IDs', async () => {
    const removed = [];
    await cascadeDeleteProject('project-1', {
      listSandboxes: async () => ({
        sandboxes: [
          { sandboxId: 'legacy-direct', projectId: 'sha256:project-1' },
          { sandboxId: 'legacy-tag', projectId: '', tags: [{ name: 'project', value: 'sha256:project-1' }] },
        ],
        nextCursor: '',
      }),
      removeSandbox: async (request) => {
        removed.push(request.sandboxId);
        return { sandboxId: request.sandboxId, removed: true };
      },
      removeProject: async () => ({}),
    });
    expect(removed).toEqual(['legacy-direct', 'legacy-tag']);
  });
});

describe('getAppliedProjectId', () => {
  test('uses the project returned by Apply instead of a stale selected project', () => {
    const response = { project: { summary: { projectId: 'project-new' } } };

    expect(getAppliedProjectId(response, 'project-removed')).toBe('project-new');
  });

  test('falls back to the selected project when Apply omits its project', () => {
    expect(getAppliedProjectId({}, 'project-current')).toBe('project-current');
  });
});

describe('stopProjectRuns', () => {
  test('stops pending and running runs without removing the project', async () => {
    const listedStatuses = [];
    const stoppedRuns = [];

    const result = await stopProjectRuns({
      projectId: 'project-1',
      client: {
        listRuns: async (request) => {
          listedStatuses.push(request.status);
          if (request.status === RunStatus.PENDING) {
            return { runs: [{ runId: 'pending-1' }] };
          }
          return { runs: [{ runId: 'running-1' }] };
        },
        stopRun: async (request) => {
          stoppedRuns.push({ runId: request.runId, reason: request.reason });
        },
      },
    });

    expect(listedStatuses).toEqual([RunStatus.PENDING, RunStatus.RUNNING]);
    expect(stoppedRuns).toEqual([
      { runId: 'pending-1', reason: 'stopped from web console' },
      { runId: 'running-1', reason: 'stopped from web console' },
    ]);
    expect(result).toEqual({ attempted: 2, stopped: 2, failed: 0, errors: [] });
  });

  test('paginates run discovery before stopping so no active run is skipped', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ runId: `run-${index}` }));
    const listOffsets = [];
    let stopCalls = 0;

    const result = await stopProjectRuns({
      projectId: 'project-1',
      client: {
        listRuns: async (request) => {
          listOffsets.push([request.status, request.offset]);
          if (request.status === RunStatus.PENDING) return { runs: [] };
          return { runs: request.offset === 0 ? firstPage : [{ runId: 'run-200' }] };
        },
        stopRun: async () => { stopCalls++; },
      },
    });

    expect(listOffsets).toEqual([
      [RunStatus.PENDING, 0],
      [RunStatus.RUNNING, 0],
      [RunStatus.RUNNING, 200],
    ]);
    expect(stopCalls).toBe(201);
    expect(result).toEqual({ attempted: 201, stopped: 201, failed: 0, errors: [] });
  });

  test('continues stopping other runs and reports failures', async () => {
    const result = await stopProjectRuns({
      projectId: 'project-1',
      client: {
        listRuns: async (request) => request.status === RunStatus.PENDING
          ? { runs: [{ runId: 'pending-1' }] }
          : { runs: [{ runId: 'running-1' }] },
        stopRun: async (request) => {
          if (request.runId === 'pending-1') throw new Error('boom');
        },
      },
    });

    expect(result).toEqual({
      attempted: 2,
      stopped: 1,
      failed: 1,
      errors: ['Failed to stop run pending-1: boom'],
    });
  });
});

describe('softPauseProject', () => {
  function client(overrides = {}) {
    return {
      listSchedulers: async () => ({ schedulers: [] }),
      getScheduler: async () => ({ scheduler: { enabled: false } }),
      setSchedulerEnabled: async ({ enabled }) => ({ scheduler: { enabled }, overridden: true }),
      listSchedulerRuns: async () => ({ runs: [] }),
      stopSchedulerRun: async () => {},
      listRuns: async () => ({ runs: [] }),
      stopRun: async () => {},
      listSandboxes: async () => ({ sandboxes: [] }),
      stopSandbox: async () => {},
      removeProject: async () => { throw new Error('RemoveProject must not be called'); },
      ...overrides,
    };
  }

  test('exhausts cursor pages and mutates only matching enabled schedulers and running sandboxes', async () => {
    const schedulerRequests = [];
    const sandboxRequests = [];
    const disabled = [];
    const stoppedSandboxes = [];
    let initialSandboxInventory = true;
    const api = client({
      listSchedulers: async (request) => {
        schedulerRequests.push({ limit: request.limit, cursor: request.cursor });
        return request.cursor === '' ? {
          schedulers: [
            { projectId: 'project-1', agentName: 'enabled', enabled: true },
            { projectId: 'project-1', agentName: 'disabled', enabled: false },
            { projectId: 'project-10', agentName: 'unrelated', enabled: true },
          ],
          nextCursor: 'scheduler-page-2',
        } : {
          schedulers: [{ projectId: 'project-1', agentName: 'page-two', enabled: true }],
        };
      },
      setSchedulerEnabled: async (request) => {
        disabled.push({
          projectId: request.project?.projectId,
          agentName: request.agentName,
          enabled: request.enabled,
        });
        return { scheduler: { enabled: request.enabled }, overridden: true };
      },
      getScheduler: async ({ agentName }) => ({ scheduler: { enabled: agentName !== 'disabled' } }),
      listSandboxes: async (request) => {
        sandboxRequests.push({ limit: request.limit, cursor: request.cursor });
        if (!initialSandboxInventory) return { sandboxes: [] };
        return request.cursor === '' ? {
          sandboxes: [
            { sandboxId: 'running', projectId: 'project-1', status: ' running ' },
            { sandboxId: 'stopped', projectId: 'project-1', status: 'STOPPED' },
            { sandboxId: 'unrelated', projectId: 'project-10', status: 'RUNNING' },
          ],
          nextCursor: 'sandbox-page-2',
        } : {
          sandboxes: [{ sandboxId: 'page-two', projectId: 'project-1', status: 'RUNNING' }],
        };
      },
      stopSandbox: async (request) => {
        stoppedSandboxes.push(request.sandboxId);
        if (request.sandboxId === 'page-two') initialSandboxInventory = false;
      },
    });

    const result = await softPauseProject({ projectId: 'project-1', client: api });

    expect(schedulerRequests.slice(0, 2)).toEqual([
      { limit: 500, cursor: '' },
      { limit: 500, cursor: 'scheduler-page-2' },
    ]);
    expect(schedulerRequests).toHaveLength(2);
    expect(sandboxRequests).toEqual([
      { limit: 500, cursor: '' },
      { limit: 500, cursor: 'sandbox-page-2' },
      { limit: 500, cursor: '' },
      { limit: 500, cursor: '' },
    ]);
    expect(disabled).toEqual([
      { projectId: 'project-1', agentName: 'enabled', enabled: false },
      { projectId: 'project-1', agentName: 'page-two', enabled: false },
    ]);
    expect(stoppedSandboxes).toEqual(['running', 'page-two']);
    expect(result).toEqual({
      schedulers: { attempted: 2, succeeded: 2, failed: 0, errors: [] },
      schedulerRuns: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
      runs: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
      sandboxes: { attempted: 2, succeeded: 2, failed: 0, errors: [] },
      failed: 0,
    });
  });

  test('stops sandboxes whose project id lives only in the project tag (webhook/scheduler runs)', async () => {
    const stoppedSandboxes = [];
    let sandboxRunning = true;
    const api = client({
      listSandboxes: async () => ({ sandboxes: sandboxRunning ? [
        // webhook/scheduler triggered loader runs expose an empty projectId;
        // the project id only appears in the `project` tag.
        { sandboxId: 'tag-only', projectId: '', status: 'RUNNING', tags: [{ name: 'project', value: 'project-1' }] },
        { sandboxId: 'unrelated', projectId: '', status: 'RUNNING', tags: [{ name: 'project', value: 'project-9' }] },
      ] : [] }),
      stopSandbox: async ({ sandboxId }) => { stoppedSandboxes.push(sandboxId); sandboxRunning = false; },
    });

    const result = await softPauseProject({ projectId: 'project-1', client: api });

    expect(stoppedSandboxes).toEqual(['tag-only']);
    expect(result.sandboxes).toEqual({ attempted: 1, succeeded: 1, failed: 0, errors: [] });
  });

  test('isolates mutation failures and maps the existing run-stage result', async () => {
    const stoppedRuns = [];
    const stoppedSandboxes = [];
    const api = client({
      listSchedulers: async () => ({ schedulers: [
        { projectId: 'project-1', agentName: 'bad', enabled: true },
        { projectId: 'project-1', agentName: 'good', enabled: true },
      ] }),
      setSchedulerEnabled: async ({ agentName }) => {
        if (agentName === 'bad') throw new Error('scheduler mutation failed');
        return { scheduler: { enabled: false }, overridden: true };
      },
      getScheduler: async () => ({ scheduler: { enabled: true } }),
      listRuns: async ({ status }) => status === RunStatus.PENDING
        ? { runs: [{ runId: 'bad-run' }] }
        : { runs: [{ runId: 'good-run' }] },
      stopRun: async ({ runId }) => {
        stoppedRuns.push(runId);
        if (runId === 'bad-run') throw new Error('run mutation failed');
      },
      listSandboxes: async () => ({ sandboxes: [
        { sandboxId: 'bad-box', projectId: 'project-1', status: 'RUNNING' },
        { sandboxId: 'good-box', projectId: 'project-1', status: 'RUNNING' },
      ] }),
      stopSandbox: async ({ sandboxId }) => {
        stoppedSandboxes.push(sandboxId);
        if (sandboxId === 'bad-box') throw new Error('sandbox mutation failed');
      },
    });

    const result = await softPauseProject({ projectId: 'project-1', client: api });

    expect(stoppedRuns).toEqual(['bad-run', 'good-run']);
    expect(stoppedSandboxes).toEqual(['bad-box', 'good-box']);
    expect(result.schedulers).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
    expect(result.schedulers.errors[0]).toContain('scheduler mutation failed');
    expect(result.runs).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      errors: ['Failed to stop run bad-run: run mutation failed'],
    });
    expect(result.sandboxes).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
    expect(result.sandboxes.errors[0]).toContain('sandbox mutation failed');
    expect(result.failed).toBe(3);
  });

  test('reports repeated cursors as list failures and continues through all later stages', async () => {
    const events = [];
    const api = client({
      listSchedulers: async ({ cursor }) => {
        events.push(`schedulers:${cursor}`);
        return { schedulers: [], nextCursor: 'same-cursor' };
      },
      listRuns: async ({ status }) => {
        events.push(`runs:${status}`);
        throw new Error('run listing failed');
      },
      listSandboxes: async ({ cursor }) => {
        events.push(`sandboxes:${cursor}`);
        return { sandboxes: [], nextCursor: 'sandbox-repeat' };
      },
    });

    const result = await softPauseProject({ projectId: 'project-1', client: api });

    expect(events).toEqual([
      'schedulers:', 'schedulers:same-cursor',
      `runs:${RunStatus.PENDING}`,
      'sandboxes:', 'sandboxes:sandbox-repeat',
    ]);
    expect(result.schedulers).toMatchObject({ attempted: 0, failed: 1 });
    expect(result.schedulers.errors[0]).toContain('same-cursor');
    expect(result.schedulerRuns).toMatchObject({ attempted: 0, failed: 0 });
    expect(result.runs).toMatchObject({ attempted: 0, failed: 1 });
    expect(result.runs.errors[0]).toContain('run listing failed');
    expect(result.sandboxes).toMatchObject({ attempted: 0, failed: 1 });
    expect(result.sandboxes.errors[0]).toContain('sandbox-repeat');
    expect(result.failed).toBe(3);
  });

  test('reports a Scheduler failure when the backend does not confirm it disabled', async () => {
    const result = await softPauseProject({
      projectId: 'project-1',
      client: client({
        listSchedulers: async () => ({ schedulers: [
          { projectId: 'project-1', agentName: 'worker', enabled: true },
        ] }),
        getScheduler: async () => ({ scheduler: { enabled: true } }),
        listSchedulerRuns: async () => ({ runs: [] }),
        setSchedulerEnabled: async () => ({ scheduler: { enabled: true }, overridden: false }),
      }),
    });

    expect(result.schedulers).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(result.schedulers.errors[0]).toContain('未确认已禁用');
    expect(result.failed).toBe(1);
  });

  test('disables an effectively enabled Scheduler even when its list summary is stale', async () => {
    const disabled = [];
    const result = await softPauseProject({
      projectId: 'project-1',
      client: client({
        listSchedulers: async () => ({ schedulers: [
          { projectId: 'project-1', agentName: 'collector', enabled: false },
        ] }),
        getScheduler: async () => ({ scheduler: { enabled: true } }),
        setSchedulerEnabled: async ({ agentName, enabled }) => {
          disabled.push({ agentName, enabled });
          return { scheduler: { enabled: false }, overridden: true };
        },
      }),
    });

    expect(disabled).toEqual([{ agentName: 'collector', enabled: false }]);
    expect(result.schedulers).toEqual({ attempted: 1, succeeded: 1, failed: 0, errors: [] });
    expect(result.failed).toBe(0);
  });

  test('stops a late run created after the first pause scan before reporting success', async () => {
    const stoppedRuns = [];
    let pendingScans = 0;
    const result = await softPauseProject({
      projectId: 'project-1',
      client: client({
        listRuns: async ({ status }) => {
          if (status !== RunStatus.PENDING) return { runs: [] };
          pendingScans++;
          return pendingScans === 2 ? { runs: [{ runId: 'late-run' }] } : { runs: [] };
        },
        stopRun: async ({ runId }) => { stoppedRuns.push(runId); },
      }),
    });

    expect(pendingScans).toBeGreaterThanOrEqual(3);
    expect(stoppedRuns).toEqual(['late-run']);
    expect(result.runs).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.failed).toBe(0);
  });

  test('paginates and stops running Scheduler Runs, including one that appears in a later convergence round', async () => {
    const requests = [];
    const stopped = [];
    let firstRunActive = true;
    let rootScans = 0;
    const result = await softPauseProject({
      projectId: 'project-1',
      client: client({
        listSchedulers: async () => ({ schedulers: [
          { projectId: 'project-1', agentName: 'collector' },
        ] }),
        listSchedulerRuns: async ({ project, agentName, cursor }) => {
          requests.push({ projectId: project?.projectId, agentName, cursor });
          if (cursor === 'page-2') {
            return { runs: firstRunActive ? [{ runId: 'first', status: SchedulerRunStatus.RUNNING }] : [] };
          }
          rootScans++;
          if (rootScans === 1) return {
            runs: [{ runId: 'finished', status: SchedulerRunStatus.SUCCEEDED }],
            nextCursor: 'page-2',
          };
          if (rootScans === 2) return { runs: [{ runId: 'late', status: SchedulerRunStatus.RUNNING }] };
          return { runs: [] };
        },
        stopSchedulerRun: async ({ project, runId, reason }) => {
          stopped.push({ projectId: project?.projectId, runId, reason });
          if (runId === 'first') firstRunActive = false;
        },
      }),
    });

    expect(requests.slice(0, 2)).toEqual([
      { projectId: 'project-1', agentName: '', cursor: '' },
      { projectId: 'project-1', agentName: '', cursor: 'page-2' },
    ]);
    expect(stopped).toEqual([
      { projectId: 'project-1', runId: 'first', reason: 'project paused from web console' },
      { projectId: 'project-1', runId: 'late', reason: 'project paused from web console' },
    ]);
    expect(result.schedulerRuns).toEqual({ attempted: 2, succeeded: 2, failed: 0, errors: [] });
    expect(rootScans).toBeGreaterThanOrEqual(4);
    expect(result.failed).toBe(0);
  });

  test('reports a repeated Scheduler Run cursor as a stage failure', async () => {
    const result = await softPauseProject({
      projectId: 'project-1',
      client: client({
        listSchedulers: async () => ({ schedulers: [{ projectId: 'project-1', agentName: 'collector' }] }),
        listSchedulerRuns: async () => ({ runs: [], nextCursor: 'repeat' }),
      }),
    });

    expect(result.schedulerRuns.failed).toBe(1);
    expect(result.schedulerRuns.errors[0]).toContain('repeat');
    expect(result.failed).toBe(1);
  });

  test('reports failure instead of success when project activity never converges', async () => {
    let scan = 0;
    const stoppedRuns = [];
    const result = await softPauseProject({
      projectId: 'project-1',
      client: client({
        listRuns: async ({ status }) => status === RunStatus.PENDING
          ? { runs: [{ runId: `run-${++scan}` }] }
          : { runs: [] },
        stopRun: async ({ runId }) => { stoppedRuns.push(runId); },
      }),
    });

    expect(stoppedRuns).toHaveLength(6);
    expect(result.runs.failed).toBe(1);
    expect(result.runs.errors).toContain('项目暂停在 6 轮检查后仍未收敛');
    expect(result.failed).toBe(1);
  });
});

describe('probeProjectRuntimeActivity', () => {
  test('detects a running Scheduler Run even when its Scheduler is disabled', async () => {
    const result = await probeProjectRuntimeActivity({
      projectId: 'project-1',
      client: {
        listSchedulers: async () => ({ schedulers: [{ projectId: 'project-1', agentName: 'worker' }] }),
        getScheduler: async () => ({ scheduler: { enabled: false } }),
        listSchedulerRuns: async () => ({ runs: [{ runId: 'active', status: SchedulerRunStatus.RUNNING }] }),
        listRuns: async () => ({ runs: [] }),
        listSandboxes: async () => ({ sandboxes: [] }),
      },
    });

    expect(result).toEqual({ scheduler: false, schedulerRun: true, run: false, sandbox: false, active: true });
  });
  test('detects each pausable resource from live paginated project state', async () => {
    const scheduler = await probeProjectRuntimeActivity({
      projectId: 'project-1',
      client: {
        listSchedulers: async ({ cursor }) => cursor
          ? { schedulers: [{ projectId: 'project-1', agentName: 'worker', enabled: true }] }
          : { schedulers: [{ projectId: 'other', enabled: true }], nextCursor: 'next' },
        getScheduler: async () => ({ scheduler: { enabled: true } }),
        listSchedulerRuns: async () => ({ runs: [] }),
        listRuns: async () => ({ runs: [] }),
        listSandboxes: async () => ({ sandboxes: [] }),
      },
    });
    expect(scheduler).toEqual({ scheduler: true, schedulerRun: false, run: false, sandbox: false, active: true });

    const run = await probeProjectRuntimeActivity({
      projectId: 'project-1',
      client: {
        listSchedulers: async () => ({ schedulers: [] }),
        listSchedulerRuns: async () => ({ runs: [] }),
        listRuns: async ({ status }) => ({ runs: status === RunStatus.RUNNING ? [{ projectId: 'project-1' }] : [] }),
        listSandboxes: async () => ({ sandboxes: [] }),
      },
    });
    expect(run).toEqual({ scheduler: false, schedulerRun: false, run: true, sandbox: false, active: true });

    const sandbox = await probeProjectRuntimeActivity({
      projectId: 'project-1',
      client: {
        listSchedulers: async () => ({ schedulers: [] }),
        listSchedulerRuns: async () => ({ runs: [] }),
        listRuns: async () => ({ runs: [] }),
        listSandboxes: async () => ({ sandboxes: [
          { projectId: 'other', status: 'RUNNING' },
          { projectId: 'project-1', status: ' running ' },
        ] }),
      },
    });
    expect(sandbox).toEqual({ scheduler: false, schedulerRun: false, run: false, sandbox: true, active: true });
  });

  test('returns inactive when all matching project resources are already paused', async () => {
    const result = await probeProjectRuntimeActivity({
      projectId: 'project-1',
      client: {
        listSchedulers: async () => ({ schedulers: [{ projectId: 'project-1', enabled: false }] }),
        getScheduler: async () => ({ scheduler: { enabled: false }, overridden: true }),
        listSchedulerRuns: async () => ({ runs: [] }),
        listRuns: async () => ({ runs: [] }),
        listSandboxes: async () => ({ sandboxes: [{ projectId: 'project-1', status: 'STOPPED' }] }),
      },
    });
    expect(result).toEqual({ scheduler: false, schedulerRun: false, run: false, sandbox: false, active: false });
  });

  test('uses effective GetScheduler state instead of stale YAML state from ListSchedulers', async () => {
    const result = await probeProjectRuntimeActivity({
      projectId: 'project-1',
      client: {
        listSchedulers: async () => ({ schedulers: [{ projectId: 'project-1', agentName: 'worker', enabled: true }] }),
        getScheduler: async () => ({ scheduler: { enabled: false }, overridden: true }),
        listSchedulerRuns: async () => ({ runs: [] }),
        listRuns: async () => ({ runs: [] }),
        listSandboxes: async () => ({ sandboxes: [] }),
      },
    });
    expect(result.scheduler).toBe(false);
    expect(result.active).toBe(false);
  });
});


describe('runProjectAgents', () => {
  test('ordinary-runs every applied agent including agents with schedulers', async () => {
    const requests = [];
    const started = [];
    let settled = 0;
    await runProjectAgents({
      projectId: 'project-1',
      agents: [
        { name: 'scheduled', prompt: 'scheduled prompt', hasScheduler: true },
        { name: 'plain', prompt: 'plain prompt', hasScheduler: false },
      ],
      client: { runAgent: async (request) => { requests.push(request); } },
      onStarted: (name) => started.push(name),
      onFailed: () => {},
      onSettled: () => settled++,
    });
    expect(requests.map(({ projectId, agentName, prompt, source }) => ({ projectId, agentName, prompt, source }))).toEqual([
      { projectId: 'project-1', agentName: 'scheduled', prompt: 'scheduled prompt', source: RunSource.MANUAL },
      { projectId: 'project-1', agentName: 'plain', prompt: 'plain prompt', source: RunSource.MANUAL },
    ]);
    expect(started).toEqual(['scheduled', 'plain']);
    expect(settled).toBe(2);
  });

  test('continues after a failed v2 run and settles every agent', async () => {
    const failed = [];
    const started = [];
    let settled = 0;
    await runProjectAgents({
      projectId: 'project-1',
      agents: [{ name: 'bad', prompt: 'x' }, { name: 'good', prompt: 'y' }],
      client: { runAgent: async (request) => { if (request.agentName === 'bad') throw new Error('boom'); } },
      onStarted: (name) => started.push(name),
      onFailed: (name) => failed.push(name),
      onSettled: () => settled++,
    });
    expect(failed).toEqual(['bad']);
    expect(started).toEqual(['good']);
    expect(settled).toBe(2);
  });
});
