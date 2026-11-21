import { createHash } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Sql } from 'postgres';
import type { ConnectorIdentity } from './connector-auth';

export const MENU_IMAGE_NAME = '^[a-f0-9]{64}\\.(webp|png|jpeg|gif)$';
const NAME = new RegExp(MENU_IMAGE_NAME);
const MAX_IMAGE_BYTES = 131_072;
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export interface MenuImageStore {
  save(tenantId: string, images: { name: string; bytes: Buffer }[]): Promise<void>;
  present(tenantId: string, names: string[]): Promise<string[]>;
  read(name: string): Promise<Buffer | null>;
}

export function postgresMenuImageStore(sql: Sql): MenuImageStore {
  return {
    async save(tenantId, images) {
      for (const image of images) {
        await sql`
          INSERT INTO menu_images (tenant_id, name, bytes) VALUES (${tenantId}, ${image.name}, ${image.bytes})
          ON CONFLICT (tenant_id, name) DO NOTHING
        `;
      }
    },
    async present(tenantId, names) {
      const rows = await sql<{ name: string }[]>`
        SELECT name FROM menu_images WHERE tenant_id = ${tenantId} AND name = ANY(${names}::text[])
      `;
      return rows.map((row) => row.name);
    },
    async read(name) {
      const [row] = await sql<{ bytes: Buffer }[]>`SELECT bytes FROM menu_images WHERE name = ${name} LIMIT 1`;
      return row ? Buffer.from(row.bytes) : null;
    },
  };
}

/** Bytes of an uploaded photo when its content matches its hash name and file type, else null. */
export function verifiedMenuImage(name: string, data: string) {
  if (!NAME.test(name) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  const ext = name.slice(65);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !SIGNATURES[ext](bytes)) return null;
  return createHash('sha256').update(bytes).digest('hex') === name.slice(0, 64) ? bytes : null;
}

interface Options {
  store: MenuImageStore;
  authorize(request: Request): ConnectorIdentity | null | Promise<ConnectorIdentity | null>;
}

const reply = (status: number, body: object) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export function menuImages({ store, authorize }: Options) {
  return new Elysia({ name: 'menu-images' })
    .post(
      '/api/v1/connectors/menu-images',
      async ({ request, body }) => {
        const identity = await authorize(request);
        if (!identity) return reply(401, { error: 'unauthorized' });
        const names = [...new Set(body.names)];
        if (names.length !== body.names.length) return reply(400, { error: 'duplicate image names' });
        const accepted = (body.images ?? []).flatMap((image) => {
          if (!names.includes(image.name)) return [];
          const bytes = verifiedMenuImage(image.name, image.data);
          return bytes ? [{ name: image.name, bytes }] : [];
        });
        if (accepted.length) await store.save(identity.tenantId, accepted);
        const present = new Set(await store.present(identity.tenantId, names));
        return reply(200, { missing: names.filter((name) => !present.has(name)) });
      },
      {
        body: t.Object({
          names: t.Array(t.String({ pattern: MENU_IMAGE_NAME }), { minItems: 1, maxItems: 1000 }),
          images: t.Optional(
            t.Array(
              t.Object({ name: t.String({ pattern: MENU_IMAGE_NAME }), data: t.String({ minLength: 1, maxLength: 175_000 }) }),
              { maxItems: 20 },
            ),
          ),
        }),
      },
    )
    .get('/api/v1/menu-images/:name', async ({ params }) => {
      if (!NAME.test(params.name)) return new Response('Not found', { status: 404 });
      const bytes = await store.read(params.name);
      if (!bytes) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': `image/${params.name.slice(65)}`,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      });
    });
}
