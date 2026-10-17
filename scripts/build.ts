/**
 * Builds the single-file binary. Ink imports `react-devtools-core` (an optional peer it only
 * loads when DEV=true); the bundler can't leave that lazy, so it resolves to an empty stub here.
 */
const result = await Bun.build({
  entrypoints: ['src/cli.ts'],
  compile: { outfile: 'dist/cookie' },
  plugins: [
    {
      name: 'no-react-devtools',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents:
            'export default { initialize() {}, connectToDevTools() {} };',
          loader: 'js',
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log('Built dist/cookie');
