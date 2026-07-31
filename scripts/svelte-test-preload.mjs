import { compileModule, compile } from 'svelte/compiler';

const tsTranspiler = new Bun.Transpiler({ loader: 'ts' });

Bun.plugin({
  name: 'svelte-test-loader',
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const jsSource = tsTranspiler.transformSync(source);
      const result = compileModule(jsSource, { generate: 'client', filename: args.path });
      return { contents: result.js.code, loader: 'js' };
    });
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const result = compile(source, { generate: 'client', filename: args.path });
      return { contents: result.js.code, loader: 'js' };
    });
  },
});
