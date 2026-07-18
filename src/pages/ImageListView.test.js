import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ImageListView.svelte', import.meta.url), 'utf8');

test('lists daemon images with server-side filters and pagination', () => {
  assert.match(source, /new ListImagesRequest/);
  assert.match(source, /query: query\.trim\(\)/);
  assert.match(source, /store: storeFilter/);
  assert.match(source, /all: showIntermediate/);
  assert.match(source, /includeCacheStatus: true/);
  assert.match(source, /offset: reset \? 0 : nextOffset/);
  assert.match(source, /limit: PAGE_SIZE/);
  assert.match(source, /resp\.hasMore/);
  assert.match(source, /resp\.nextOffset/);
});

test('guards list state against stale responses and reports store availability', () => {
  assert.match(source, /requestGeneration/);
  assert.match(source, /generation !== requestGeneration/);
  assert.match(source, /storeStatus/);
  assert.match(source, /后端未提供/);
});

test('is a management surface and does not offer generic image creation', () => {
  assert.match(source, /已有镜像/);
  assert.match(source, /PullImageModal/);
  assert.match(source, /RemoveImageModal/);
  assert.doesNotMatch(source, /BuildImageModal/);
  assert.doesNotMatch(source, />构建镜像</);
});

test('places refresh and pull actions at the right edge of the filter row', () => {
  assert.doesNotMatch(source, /<header>(?:(?!<\/header>)[\s\S])*?<div class="header-actions">/);
  assert.match(source, /<div class="filters">[\s\S]*?<span class="filter-spacer"><\/span>[\s\S]*?<div class="header-actions">[\s\S]*?刷新[\s\S]*?拉取镜像/);
});

test('classifies rows, expands details inline, and supports current-page bulk selection', () => {
  assert.match(source, /image\.dangling/);
  assert.match(source, /中间层/);
  assert.match(source, /成品镜像/);
  assert.match(source, /selectedKeys/);
  assert.match(source, /选择当前已加载镜像/);
  assert.match(source, /删除所选/);
  assert.match(source, /data-image-detail/);
  assert.doesNotMatch(source, /<aside class="detail">/);
});
