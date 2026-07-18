import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import StatusIndicator from '../../src/components/StatusIndicator.svelte';

// 样例组件测试：验证 vitest + happy-dom + @testing-library/svelte 在 Svelte 5 下的渲染链路。
describe('StatusIndicator', () => {
  it('synced 时显示「已同步」并带 synced 类', () => {
    const { container } = render(StatusIndicator, { props: { specHash: '', synced: true } });
    expect(screen.getByText(/已同步/)).toBeInTheDocument();
    expect(container.querySelector('.status')).toHaveClass('synced');
  });

  it('未 synced 但有 specHash 时显示前 7 位', () => {
    const { container } = render(StatusIndicator, { props: { specHash: 'abcdef123456', synced: false } });
    expect(screen.getByText('abcdef1')).toBeInTheDocument();
    expect(container.querySelector('.status')).not.toHaveClass('synced');
  });

  it('既无 synced 也无 specHash 时显示「未保存」', () => {
    render(StatusIndicator, { props: {} });
    expect(screen.getByText(/未保存/)).toBeInTheDocument();
  });
});
