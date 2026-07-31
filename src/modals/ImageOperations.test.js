import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { ImageOperationStatus } from '../gen/agentcompose/v2/agentcompose_pb';
import { readFileSync } from 'node:fs';

const pull = readFileSync(new URL('./PullImageModal.svelte', import.meta.url), 'utf8');
const remove = readFileSync(new URL('./RemoveImageModal.svelte', import.meta.url), 'utf8');
const list = readFileSync(new URL('../pages/ImageListView.svelte', import.meta.url), 'utf8');

test('pulls an image with store and optional platform in the current request', () => {
  assert.match(pull, /new PullImageRequest/);
  assert.match(pull, /imageRef/);
  assert.match(pull, /store: storeKind/);
  assert.match(pull, /new ImagePlatform/);
  assert.match(pull, /当前请求/);
  assert.match(pull, /response\.progress/);
  assert.match(pull, /response\.warnings/);
});

test('removes an image with explicit dangerous options and response evidence', () => {
  assert.match(remove, /removeImagesSequentially/);
  assert.match(remove, /pendingImages/);
  assert.match(remove, /重试失败项/);
  assert.match(remove, /force/);
  assert.match(remove, /pruneChildren/);
  assert.match(remove, /window\.confirm/);
  assert.match(remove, /untaggedRefs/);
  assert.match(remove, /deletedIds/);
  assert.match(remove, /warnings/);
});

test('build request includes every v2 option and streaming events remain visible', async () => {
  const { createBuildImageRequest, consumeBuildImageEvents } = await import('./build-image');
  const request = createBuildImageRequest({
    contextDir: '/srv/build/demo', dockerfile: 'Containerfile', tagsText: 'demo:dev\ndemo:latest',
    buildArgsText: 'MODE=release\nEMPTY=', target: 'runtime', store: 1,
    os: 'linux', architecture: 'arm64', variant: 'v8', noCache: true, pull: true,
  });
  assert.equal(request.contextDir, '/srv/build/demo');
  assert.equal(request.dockerfile, 'Containerfile');
  assert.deepEqual(request.tags, ['demo:dev', 'demo:latest']);
  assert.deepEqual(request.buildArgs, { MODE: 'release', EMPTY: '' });
  assert.equal(request.target, 'runtime');
  assert.equal(request.store, 1);
  assert.deepEqual(
    { os: request.platform.os, architecture: request.platform.architecture, variant: request.platform.variant },
    { os: 'linux', architecture: 'arm64', variant: 'v8' },
  );
  assert.equal(request.noCache, true);
  assert.equal(request.pull, true);

  async function* events() {
    yield { stage: 'resolve', message: 'reading Dockerfile', warnings: ['legacy syntax'] };
    yield { stage: 'export', message: 'done', imageRef: 'demo:dev', resolvedRef: 'sha256:abc', image: { imageId: 'abc' }, warnings: [] };
  }
  const snapshots = [];
  const result = await consumeBuildImageEvents(events(), (state) => snapshots.push(structuredClone(state)));
  assert.deepEqual(result.lines.map((line) => [line.stage, line.message]), [['resolve', 'reading Dockerfile'], ['export', 'done']]);
  assert.deepEqual(result.warnings, ['legacy syntax']);
  assert.equal(result.imageRef, 'demo:dev');
  assert.equal(result.resolvedRef, 'sha256:abc');
  assert.equal(result.image.imageId, 'abc');
  assert.equal(snapshots.length, 2);
});

test('keeps partial stream output when the build disconnects', async () => {
  const { consumeBuildImageEvents } = await import('./build-image');
  async function* events() { yield { stage: 'build', message: 'step 1' }; throw new Error('connection lost'); }
  const snapshots = [];
  await assert.rejects(consumeBuildImageEvents(events(), (state) => snapshots.push(structuredClone(state))), /connection lost/);
  assert.equal(snapshots.at(-1).lines[0].message, 'step 1');
});

test('treats a FAILED terminal event as visible failure while preserving prior output', async () => {
  const { consumeBuildImageEvents, BuildImageFailedError } = await import('./build-image');
  async function* events() {
    yield { status: ImageOperationStatus.RUNNING, stage: 'build', message: 'step 1', warnings: ['cached'] };
    yield { status: ImageOperationStatus.FAILED, stage: 'export', message: 'builder failed', resolvedRef: 'sha256:partial' };
  }
  const snapshots = [];
  await assert.rejects(consumeBuildImageEvents(events(), (state) => snapshots.push(structuredClone(state))), BuildImageFailedError);
  assert.deepEqual(snapshots.at(-1).lines.map((line) => line.message), ['step 1', 'builder failed']);
  assert.deepEqual(snapshots.at(-1).warnings, ['cached']);
  assert.equal(snapshots.at(-1).resolvedRef, 'sha256:partial');
});

test('keeps daemon images management-only while project YAML owns builds', () => {
  assert.match(list, /new InspectImageRequest/);
  assert.match(list, /includeCacheStatus: true/);
  assert.match(list, /imageService\.inspectImage/);
  assert.match(list, /已有镜像/);
  assert.doesNotMatch(list, />构建镜像</);
  assert.doesNotMatch(list, /BuildImageModal/);
  assert.doesNotMatch(list, /后台任务/);
});
