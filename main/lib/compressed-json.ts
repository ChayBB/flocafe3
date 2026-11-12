import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import type { Request, Response } from 'express';

const gzip = promisify(zlib.gzip);

type Encoded = { json: Buffer; gzip: Promise<Buffer> };
const encodedBodies = new WeakMap<object, Encoded>();

function encode(value: object): Encoded {
  let entry = encodedBodies.get(value);
  if (!entry) {
    const json = Buffer.from(JSON.stringify(value));
    entry = { json, gzip: gzip(json, { level: 6 }) };
    encodedBodies.set(value, entry);
  }
  return entry;
}

/** Sends a shared, unchanging JSON object gzip-compressed, encoding it once per object. */
export async function sendCachedJson(req: Request, res: Response, value: object): Promise<void> {
  const entry = encode(value);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.acceptsEncodings('gzip') === 'gzip') {
    const body = await entry.gzip;
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.end(body);
    return;
  }
  res.setHeader('Content-Length', entry.json.length);
  res.end(entry.json);
}
