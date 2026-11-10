const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const frontend = path.join(root, 'frontend');
const fromFrontend = createRequire(path.join(frontend, 'package.json'));
const out = path.join(root, 'dist', 'cloud-ordering');
const site = path.join(root, 'flocafe-ordering');

function configuredStaffUrl() {
  const address = process.env.FLO_CLOUD_STAFF_URL?.trim();
  if (!address) return undefined;
  const url = new URL(address);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/server-standalone/'
  ) {
    throw new Error('FLO_CLOUD_STAFF_URL must be a Server App URL ending in /server-standalone/');
  }
  return url.href;
}

function exportPresentation() {
  const db = new DatabaseSync(path.join(root, 'flo.db'), { readOnly: true });
  try {
    const categories = db
      .prepare(`
      SELECT id, name, slug, description, parent_id, sort_order, color, icon
      FROM categories WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order, name
    `)
      .all()
      .map((row) => ({ ...row, is_active: true }));
    const variants = db.prepare(`
      SELECT name, sort_order AS sortOrder FROM product_variants
      WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, name, id
    `);
    const products = db
      .prepare(`
      SELECT id, name, category_id AS categoryId, image_url, tags FROM products
      WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order, name
    `)
      .all()
      .map(({ image_url, tags, ...product }) => {
        const match = /^data:image\/(webp|png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/.exec(
          image_url ?? '',
        );
        let image;
        if (match) {
          const bytes = Buffer.from(match[2], 'base64');
          const hash = createHash('sha256').update(bytes).digest('hex');
          image = `menu-images/${hash}.${match[1]}`;
          fs.writeFileSync(path.join(out, image), bytes);
        }
        return {
          ...product,
          image,
          tags: tags ? JSON.parse(tags) : [],
          variants: variants.all(product.id),
        };
      });
    const popular = db
      .prepare(`
      SELECT i.product_id FROM order_items i JOIN orders o ON o.id = i.order_id
      JOIN products p ON p.id = i.product_id
      WHERE o.created_at >= datetime('now', '-30 days') AND o.status != 'cancelled'
        AND i.status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
        AND p.is_active = 1 AND p.deleted_at IS NULL
      GROUP BY i.product_id ORDER BY SUM(i.quantity) DESC, i.product_id LIMIT 10
    `)
      .all()
      .map((row) => row.product_id);
    fs.writeFileSync(
      path.join(out, 'menu-presentation.json'),
      JSON.stringify({
        categories,
        products,
        popular,
        staffUrl: configuredStaffUrl(),
      }),
    );
    return {
      products: products.length,
      images: products.filter((product) => product.image).length,
    };
  } finally {
    db.close();
  }
}

async function main() {
  fs.mkdirSync(path.join(out, 'menu-images'), { recursive: true });
  const entry = path.join(frontend, 'src', 'cloud-ordering.tsx');
  const bundle = spawnSync(
    'bun',
    [
      'build',
      entry,
      '--target=browser',
      '--minify',
      '--production',
      '--splitting',
      '--outdir',
      out,
      '--entry-naming',
      'order.js',
      '--chunk-naming',
      'chunks/[name]-[hash].[ext]',
      '--tsconfig-override',
      path.join(frontend, 'tsconfig.json'),
    ],
    { stdio: 'inherit', cwd: frontend },
  );
  if (bundle.status !== 0) throw bundle.error ?? new Error('Browser build failed');
  const cssPath = path.join(frontend, 'src', 'app', 'globals.css');
  const css = await fromFrontend('postcss')([
    fromFrontend('@tailwindcss/postcss')({ base: frontend, optimize: true }),
  ]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath, to: path.join(out, 'styles.css') });
  fs.writeFileSync(path.join(out, 'styles.css'), css.css);
  fs.copyFileSync(path.join(site, 'pos.html'), path.join(out, 'index.html'));
  fs.copyFileSync(path.join(site, '_redirects'), path.join(out, '_redirects'));
  console.log(JSON.stringify(exportPresentation()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
