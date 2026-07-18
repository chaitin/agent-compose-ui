import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';

test('uses compact desktop sizing and automatic mobile height', () => {
  const source = readFileSync('src/views/runtime/RuntimeBreadcrumb.svelte', 'utf8');

  expect(source).toMatch(/\.runtime-breadcrumb\s*\{[^}]*height:\s*41px/);
  expect(source).toMatch(/\.runtime-breadcrumb\s*\{[^}]*padding:\s*5px 12px/);
  expect(source).toMatch(/h2\s*\{[^}]*font-size:\s*var\(--font-size-lg\)/);
  expect(source).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*\.runtime-breadcrumb\s*\{[^}]*height:\s*auto/);
});

test('renders the Agent-detail breadcrumb structure and routes its actions', async () => {
  const onBack = vi.fn();
  const onRefresh = vi.fn();
  render(RuntimeBreadcrumb, {
    eyebrow: '智能体运行历史',
    title: 'reviewer',
    onBack,
    status: '运行中',
    statusTone: 'running',
    actions: [{ label: '刷新', onclick: onRefresh, variant: 'primary' }],
  });

  expect(screen.getByRole('navigation', { name: '页面路径' })).toHaveTextContent('智能体运行历史');
  expect(screen.getByRole('heading', { name: 'reviewer' })).toBeInTheDocument();
  expect(screen.getByText('运行中')).toHaveClass('running');
  await fireEvent.click(screen.getByRole('button', { name: '返回' }));
  await fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(onBack).toHaveBeenCalledOnce();
  expect(onRefresh).toHaveBeenCalledOnce();
});

test('supports a root page without a back button', () => {
  render(RuntimeBreadcrumb, { eyebrow: '智能体列表', title: 'demo' });
  expect(screen.queryByRole('button', { name: '返回' })).toBeNull();
});

test('opts the back button and selected actions into compact presentation while retaining hidden actions', () => {
  render(RuntimeBreadcrumb, {
    eyebrow: '智能体运行历史',
    title: 'collector',
    onBack: vi.fn(),
    actions: [
      { label: '手动运行', onclick: vi.fn(), compact: true },
      { label: 'Sandbox 清单', onclick: vi.fn(), hidden: true },
    ],
  });

  expect(screen.getByRole('button', { name: '返回' })).toHaveClass('back');
  expect(screen.getByRole('button', { name: '手动运行' })).toHaveClass('compact');
  const sandbox = screen.getAllByRole('button', { hidden: true })
    .find((button) => button.getAttribute('aria-label') === 'Sandbox 清单');
  expect(sandbox).toHaveAttribute('hidden');
});

test('shares the back treatment with selected actions at a 22px midpoint height', () => {
  render(RuntimeBreadcrumb, {
    eyebrow: '智能体列表',
    title: 'demo',
    onBack: vi.fn(),
    actions: [{ label: '最近运行结果 →', onclick: vi.fn(), variant: 'back' }],
  });
  expect(screen.getByRole('button', { name: '返回' })).toHaveClass('back');
  expect(screen.getByRole('button', { name: '最近运行结果 →' })).toHaveClass('back');

  const source = readFileSync('src/views/runtime/RuntimeBreadcrumb.svelte', 'utf8');
  const baseButtonRule = source.match(/(?:^|\n)\s*button\s*\{([^}]*)\}/)?.[1] ?? '';

  expect(source).toMatch(/\.back\s*,\s*button\.compact\s*\{[^}]*height:\s*22px[^}]*\}/);
  expect(baseButtonRule).not.toMatch(/height:\s*22px/);
});
