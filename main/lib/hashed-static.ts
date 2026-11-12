import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';
import { resolveContainedPath } from './path-containment';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const HASHED_PREFIX = '/_next/static/';
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

type Encoded = { mtimeMs: number; br: Promise<Buffer>; gzip: Promise<Buffer> };

/**
 * Serves content-hashed Next.js build assets compressed and cached for a year.
 * Phones load the Server App over Wi-Fi, where the uncompressed 1.8 MB bundle dominated load time.
 */
export function hashedStaticAssets(staticDir: string) {
  const cache = new Map<string, Encoded>();
  return async (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.path.startsWith(HASHED_PREFIX)) {
      return next();
    }
    const type = TYPES[path.extname(req.path)];
    const encoding = req.acceptsEncodings('br', 'gzip');
    const file = resolveContainedPath(staticDir, `.${req.path}`);
    if (!type || (encoding !== 'br' && encoding !== 'gzip') || !file) return next();
    try {
      const { mtimeMs } = await fs.promises.stat(file);
      let entry = cache.get(file);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        const bytes = fs.promises.readFile(file);
        entry = {
          mtimeMs,
          br: bytes.then((body) =>
            brotli(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
          ),
          gzip: bytes.then((body) => gzip(body, { level: 9 })),
        };
        entry.br.catch(() => cache.delete(file));
        entry.gzip.catch(() => cache.delete(file));
        cache.set(file, entry);
      }
      const body = await entry[encoding];
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Length', body.length);
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    } catch {
      next();
    }
  };
}
