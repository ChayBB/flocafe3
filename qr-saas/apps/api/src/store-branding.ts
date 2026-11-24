import { createHash } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Sql } from 'postgres';
import type { ConnectorIdentity } from './connector-auth';
import { inTenant } from './tenant-scope';

export const BRANDING_IMAGE_NAME = '^[a-f0-9]{64}\\.(webp|png|jpeg|gif)$';
const NAME = new RegExp(BRANDING_IMAGE_NAME);
export const MAX_BRANDING_IMAGE_BYTES = 1_572_864;
/** Base64 characters per upload part, so each request stays well under the proxy body limit. */
export const MAX_BRANDING_PART_CHARS = 180_000;
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export interface BrandingSelection {
  logo: string | null;
  cover: string | null;
}

export interface BrandingStore {
  /** Appends a part at `offset` (0 restarts the upload); returns the staged bytes, or null when the offset is stale. */
  stage(scope: ConnectorIdentity, name: string, offset: number, part: Buffer): Promise<Buffer | null>;
  staged(scope: ConnectorIdentity, names: string[]): Promise<Map<string, number>>;
  save(scope: ConnectorIdentity, name: string, bytes: Buffer): Promise<void>;
  discard(scope: ConnectorIdentity, name: string): Promise<void>;
  present(tenantId: string, names: string[]): Promise<string[]>;
  select(scope: ConnectorIdentity, selection: BrandingSelection): Promise<void>;
  read(name: string): Promise<Buffer | null>;
}

export function postgresBrandingStore(sql: Sql): BrandingStore {
  return {
    async stage(scope, name, offset, part) {
      return inTenant(sql, scope, async (tx) => {
        const [row] = offset === 0
          ? await tx<{ bytes: Buffer }[]>`
              INSERT INTO branding_uploads (tenant_id, branch_id, name, bytes)
              VALUES (${scope.tenantId}, ${scope.branchId}, ${name}, ${part})
              ON CONFLICT (tenant_id, branch_id, name) DO UPDATE SET bytes = EXCLUDED.bytes, updated_at = now()
              RETURNING bytes`
          : await tx<{ bytes: Buffer }[]>`
              UPDATE branding_uploads SET bytes = bytes || ${part}, updated_at = now()
              WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND name = ${name}
                AND octet_length(bytes) = ${offset}
              RETURNING bytes`;
        return row ? Buffer.from(row.bytes) : null;
      });
    },
    async staged(scope, names) {
      const rows = await inTenant(sql, scope, (tx) => tx<{ name: string; size: number }[]>`
        SELECT name, octet_length(bytes) AS size FROM branding_uploads
        WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND name = ANY(${names}::text[])
      `);
      return new Map(rows.map((row) => [row.name, Number(row.size)]));
    },
    async save(scope, name, bytes) {
      await inTenant(sql, scope, async (tx) => {
        await tx`
          INSERT INTO branding_images (tenant_id, name, bytes) VALUES (${scope.tenantId}, ${name}, ${bytes})
          ON CONFLICT (tenant_id, name) DO NOTHING
        `;
        await tx`DELETE FROM branding_uploads WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND name = ${name}`;
      });
    },
    async discard(scope, name) {
      await inTenant(sql, scope, (tx) => tx`
        DELETE FROM branding_uploads WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND name = ${name}
      `);
    },
    async present(tenantId, names) {
      const rows = await inTenant(sql, { tenantId }, (tx) => tx<{ name: string }[]>`
        SELECT name FROM branding_images WHERE tenant_id = ${tenantId} AND name = ANY(${names}::text[])
      `);
      return rows.map((row) => row.name);
    },
    async select(scope, { logo, cover }) {
      await inTenant(sql, scope, (tx) => tx`
        UPDATE branches SET store_logo = ${logo}, store_cover = ${cover}, branding_updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND id = ${scope.branchId}
      `);
    },
    async read(name) {
      const [row] = await sql<{ bytes: Buffer }[]>`SELECT bytes FROM branding_images WHERE name = ${name} LIMIT 1`;
      return row ? Buffer.from(row.bytes) : null;
    },
  };
}

/** True when the bytes match their hash name and file type. */
export function verifiedBrandingImage(name: string, bytes: Buffer) {
  if (!NAME.test(name) || !bytes.length || bytes.length > MAX_BRANDING_IMAGE_BYTES) return false;
  if (!SIGNATURES[name.slice(65)](bytes)) return false;
  return createHash('sha256').update(bytes).digest('hex') === name.slice(0, 64);
}

interface Options {
  store: BrandingStore;
  authorize(request: Request): ConnectorIdentity | null | Promise<ConnectorIdentity | null>;
}

const reply = (status: number, body: object) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const Name = t.Union([t.String({ pattern: BRANDING_IMAGE_NAME }), t.Null()]);

/** The store logo and cover the POS pushes, served to the guest page by content hash. */
export function storeBranding({ store, authorize }: Options) {
  return new Elysia({ name: 'store-branding' })
    .post(
      '/api/v1/connectors/branding',
      async ({ request, body }) => {
        const identity = await authorize(request);
        if (!identity) return reply(401, { error: 'unauthorized' });
        const selection = { logo: body.logo, cover: body.cover };
        const names = [...new Set([body.logo, body.cover].filter((name): name is string => name !== null))];
        if (body.part) {
          const { name, offset, total, data } = body.part;
          if (!names.includes(name)) return reply(400, { error: 'part must name a selected image' });
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return reply(400, { error: 'invalid part data' });
          const staged = await store.stage(identity, name, offset, Buffer.from(data, 'base64'));
          if (staged && staged.length >= total) {
            if (staged.length > total || !verifiedBrandingImage(name, staged)) {
              await store.discard(identity, name);
              return reply(422, { error: 'image rejected' });
            }
            await store.save(identity, name, staged);
          }
        }
        const present = new Set(names.length ? await store.present(identity.tenantId, names) : []);
        const absent = names.filter((name) => !present.has(name));
        if (!absent.length) {
          await store.select(identity, selection);
          return reply(200, { missing: [] });
        }
        const received = await store.staged(identity, absent);
        return reply(200, { missing: absent.map((name) => ({ name, received: received.get(name) ?? 0 })) });
      },
      {
        body: t.Object({
          logo: Name,
          cover: Name,
          part: t.Optional(
            t.Object({
              name: t.String({ pattern: BRANDING_IMAGE_NAME }),
              offset: t.Integer({ minimum: 0, maximum: MAX_BRANDING_IMAGE_BYTES }),
              total: t.Integer({ minimum: 1, maximum: MAX_BRANDING_IMAGE_BYTES }),
              data: t.String({ minLength: 4, maxLength: MAX_BRANDING_PART_CHARS }),
            }),
          ),
        }),
      },
    )
    .get('/api/v1/menu-images/branding/:name', async ({ params }) => {
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
