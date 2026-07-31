import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

// 每个组件测试后清理挂载点，避免 DOM 互相污染。
afterEach(() => {
  cleanup();
});
