import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { BunPlugin } from 'bun';

const [entry, outdir] = process.argv.slice(2);
const messageFile = /[\\/]i18n[\\/]messages[\\/][\w-]+\.json$/;
const translationCall =
  /\b(?:useTranslations|getTranslations|createTranslator)\(\s*(?:(['"`])([^'"`]*)\1)?/g;
const base = {
  entrypoints: [entry],
  target: 'browser',
  splitting: true,
  minify: true,
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
} as const;

const scan = await Bun.build(base);
if (!scan.success) throw new AggregateError(scan.logs, 'Browser build failed');
const sources = Object.keys(scan.metafile!.inputs)
  .filter((file) => !file.includes('node_modules') && /\.[cm]?[jt]sx?$/.test(file))
  .map((file) => path.resolve(file));

// Guest pages read only a few namespaces; shipping every POS string made the bundle >1 MB.
let namespaces: Set<string> | null = new Set();
for (const file of sources) {
  for (const [, , namespace] of readFileSync(file, 'utf8').matchAll(translationCall)) {
    if (!namespace) {
      namespaces = null;
      break;
    }
    namespaces.add(namespace.split('.')[0]);
  }
  if (!namespaces) break;
}

const keep = namespaces;
const guestMessages: BunPlugin = {
  name: 'guest-messages',
  setup(build) {
    if (!keep) return;
    build.onLoad({ filter: messageFile }, async ({ path: file }) => {
      const all = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
      return {
        loader: 'json',
        contents: JSON.stringify(
          Object.fromEntries(Object.entries(all).filter(([key]) => keep.has(key))),
        ),
      };
    });
  },
};

// Guests never sign in, so the staff auth store gets a request-free client instead of axios.
const guestApi: BunPlugin = {
  name: 'guest-api',
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/api$/ }, () => ({
      path: 'guest-api',
      namespace: 'guest-api',
    }));
    build.onLoad({ filter: /.*/, namespace: 'guest-api' }, () => ({
      loader: 'js',
      contents: `const refuse = () => Promise.reject(new Error('Staff API is unavailable on the guest page'));
export default { get: refuse, post: refuse, put: refuse, patch: refuse, delete: refuse, defaults: { baseURL: '/api' } };`,
    }));
  },
};

const result = await Bun.build({
  ...base,
  outdir,
  naming: { entry: 'order.js', chunk: 'chunks/[name]-[hash].[ext]' },
  plugins: [guestMessages, guestApi],
});
if (!result.success) throw new AggregateError(result.logs, 'Browser build failed');

const outputs = result.metafile!.outputs;
const entryKey = Object.keys(outputs).find((key) => key.replace(/^\.\//, '') === 'order.js')!;
const preload = new Set<string>();
const visit = (key: string) => {
  for (const { path: next, kind } of outputs[key]?.imports ?? []) {
    if (kind !== 'import-statement') continue;
    const resolved = path.posix.join(path.posix.dirname(key), next);
    const normalized = './' + resolved.replace(/^\.\//, '');
    if (preload.has(normalized)) continue;
    preload.add(normalized);
    visit(
      Object.keys(outputs).find(
        (candidate) => './' + candidate.replace(/^\.\//, '') === normalized,
      ) ?? normalized,
    );
  }
};
visit(entryKey);

console.log(
  JSON.stringify({ sources, preload: [...preload], namespaces: keep ? [...keep] : null }),
);
