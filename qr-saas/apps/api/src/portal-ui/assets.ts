import { Elysia } from 'elysia';

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const built = await Bun.build({ entrypoints: [`${import.meta.dir}/app.ts`], minify: true, target: 'browser' });
if (!built.success) throw Error(`Portal bundle failed: ${built.logs.join('\n')}`);
const script = await built.outputs[0].text();
const page = await Bun.file(`${import.meta.dir}/index.html`).text();
const styles = await Bun.file(`${import.meta.dir}/portal.css`).text();

/** The portal is one static page plus one bundled script, served by the API itself. */
export function portalAssets() {
  return new Elysia()
    .get('/portal', () => new Response(page, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' } }))
    .get('/portal/app.js', () => new Response(script, { headers: { ...HEADERS, 'content-type': 'text/javascript; charset=utf-8' } }))
    .get('/portal/portal.css', () => new Response(styles, { headers: { ...HEADERS, 'content-type': 'text/css; charset=utf-8' } }));
}
