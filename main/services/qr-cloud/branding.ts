import { createHash } from 'node:crypto';
import { getDatabase } from '../../db';
import { decodeStoreImage, STORE_IMAGE_KEYS } from '../../lib/store-branding';
import { connectorBranding, type ConnectorBrandingBody, QrCloudClientError } from './client';
import { readConfig, readConnectorSetting, type QrCloudConfig } from './config';
import { readApprovedCa } from './tls';

/** Raw bytes per part; base64 makes each request about 180 KB, under the Cloud proxy body limit. */
const PART_BYTES = 135_000;
const FAILURE_RETRY_MS = 60_000;
const UNSUPPORTED_RETRY_MS = 60 * 60_000;

type Image = { name: string; bytes: Buffer };

let synced: string | null = null;
let retry: { key: string; at: number } | null = null;
let running: Promise<void> | null = null;

export function __resetStoreBrandingSyncForTests(): void {
  synced = null;
  retry = null;
  running = null;
}

function storeImage(value: string | undefined): Image | null {
  const image = decodeStoreImage(value);
  if (!image) return null;
  const hash = createHash('sha256').update(image.body).digest('hex');
  return { name: `${hash}.${image.type.slice('image/'.length)}`, bytes: image.body };
}

/** The logo and cover from Settings, named by content hash as the Cloud stores them. */
export function readStoreBrandingImages(): { logo: Image | null; cover: Image | null } {
  const rows = getDatabase()
    .prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
    .all(STORE_IMAGE_KEYS.logo, STORE_IMAGE_KEYS.cover) as { key: string; value: string }[];
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  return {
    logo: storeImage(value(STORE_IMAGE_KEYS.logo)),
    cover: storeImage(value(STORE_IMAGE_KEYS.cover)),
  };
}

function missingOf(response: unknown, images: Map<string, Buffer>) {
  const missing = (response as { missing?: unknown } | null)?.missing;
  if (
    !Array.isArray(missing) ||
    missing.some(
      (entry) =>
        !entry ||
        typeof entry.name !== 'string' ||
        !images.has(entry.name) ||
        !Number.isSafeInteger(entry.received) ||
        entry.received < 0 ||
        entry.received >= images.get(entry.name)!.length,
    )
  )
    throw new QrCloudClientError('bad_response', 'invalid_branding');
  return missing as { name: string; received: number }[];
}

/** Sends the selection, then the parts of each image the Cloud reports missing, until it holds both. */
export async function uploadStoreBranding(
  send: (body: ConnectorBrandingBody) => Promise<unknown>,
  logo: Image | null,
  cover: Image | null,
): Promise<void> {
  const selection = { logo: logo?.name ?? null, cover: cover?.name ?? null };
  const images = new Map(
    [logo, cover].flatMap((image) => (image ? [[image.name, image.bytes]] : [])),
  );
  const parts = [...images.values()].reduce(
    (total, bytes) => total + Math.ceil(bytes.length / PART_BYTES),
    0,
  );
  let missing = missingOf(await send(selection), images);
  for (let sent = 0; missing.length; sent += 1) {
    if (sent > parts * 2 + 2) throw new QrCloudClientError('bad_response', 'branding_not_accepted');
    const { name, received } = missing[0];
    const bytes = images.get(name)!;
    missing = missingOf(
      await send({
        ...selection,
        part: {
          name,
          offset: received,
          total: bytes.length,
          data: bytes.subarray(received, received + PART_BYTES).toString('base64'),
        },
      }),
      images,
    );
  }
}

/**
 * Pushes the Settings logo and cover to the Cloud when they differ from what it last accepted.
 * Failures wait a minute before the next try; a Cloud without the endpoint waits an hour.
 */
export function syncStoreBranding(
  config: QrCloudConfig,
  signal: AbortSignal,
  now = Date.now(),
): Promise<void> {
  if (running) return running;
  const { logo, cover } = readStoreBrandingImages();
  const key = [config.cloudUrl, logo?.name ?? '', cover?.name ?? ''].join('|');
  if (key === synced || (retry?.key === key && now < retry.at)) return Promise.resolve();
  const options = {
    config,
    token: readConnectorSetting(),
    caPem: readApprovedCa()?.pem,
  };
  running = uploadStoreBranding(
    (body) =>
      connectorBranding(
        { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) },
        body,
      ),
    logo,
    cover,
  )
    .then(() => {
      synced = key;
      retry = null;
    })
    .catch((error) => {
      const unsupported = error instanceof QrCloudClientError && error.detail === 'HTTP 404';
      retry = { key, at: now + (unsupported ? UNSUPPORTED_RETRY_MS : FAILURE_RETRY_MS) };
      throw error;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Starts a push right after Settings saves a logo or cover; the connector poll retries on failure. */
export function pushStoreBrandingSoon(): void {
  const config = readConfig();
  if (!config.enabled || config.mode !== 'integrated' || config.cutoverPending) return;
  if (!config.cloudUrl || !readConnectorSetting()) return;
  void syncStoreBranding(config, AbortSignal.timeout(config.timeoutMs * 20)).catch(() => undefined);
}
