import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// 组件层测试 runner（与 bun:test 逻辑层并存、互不干扰）。
// component 测试放在 test/ 下，靠目录与 bun test（仅扫 src/script-service/scripts）物理隔离，
// 不依赖 bunfig exclude（bun 1.3 的 [test].exclude 不可靠）。命名约定 *.component.test.ts。
export default defineConfig({
  plugins: [svelte({ hot: false })],
  // Svelte 5 在 node 测试环境下默认解析到 server 入口（exports.default=index-server，
  // 不支持 mount）；其 exports 用 `browser` 条件指向 client 入口，故显式加上。
  resolve: {
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**', 'src/**/*.{svelte,ts}'],
      exclude: ['src/gen/**', 'src/**/*.test.ts', 'test/**'],
    },
  },
});
