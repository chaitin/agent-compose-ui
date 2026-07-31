import { render, screen } from '@testing-library/svelte';
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import V2Unavailable from './V2Unavailable.svelte';

test('explains a missing v2 capability without presenting an action', () => {
  render(V2Unavailable, { props: { title: '调度器操作', reason: 'v2 未提供 Scheduler 服务' } });
  expect(screen.getByText('当前 v2 API 未提供此能力')).toBeInTheDocument();
  expect(screen.getByText('v2 未提供 Scheduler 服务')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('can hide the v2 implementation context for a user-facing placeholder', () => {
  render(V2Unavailable, {
    props: { title: '总览', reason: '敬请期待', showContext: false },
  });
  expect(screen.getByRole('heading', { name: '总览' })).toBeInTheDocument();
  expect(screen.getByText('敬请期待')).toBeInTheDocument();
  expect(screen.queryByText('当前 v2 API 未提供此能力')).not.toBeInTheDocument();
});
