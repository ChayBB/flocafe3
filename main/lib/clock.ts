import dgram from 'node:dgram';

/** Thai reference time servers, tried in order. */
export const NTP_SERVERS = ['time.navy.mi.th', 'th.pool.ntp.org'];

type NtpOptions = { port?: number; timeoutMs?: number; signal?: AbortSignal };

const NTP_PORT = 123;
const NTP_TIMEOUT_MS = 3000;
const NTP_RESYNC_MS = 60 * 60 * 1000;
// Seconds between the NTP epoch (1900) and the Unix epoch (1970).
const NTP_EPOCH_OFFSET = 2208988800;

let offsetMs = 0;
let lastSync: { server: string; at: string; offsetMs: number } | null = null;

/**
 * Business "now": the machine clock corrected by the last NTP sync. Offline, it keeps the
 * last known correction, or the machine clock when no sync has succeeded yet.
 */
export function clockNow(): Date {
  return new Date(Date.now() + offsetMs);
}

export function clockStatus(): { offsetMs: number; lastSync: typeof lastSync } {
  return { offsetMs, lastSync };
}

function writeTimestamp(buffer: Buffer, offset: number, ms: number): void {
  const seconds = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET;
  const fraction = Math.round(((ms % 1000) / 1000) * 0x100000000) >>> 0;
  buffer.writeUInt32BE(seconds >>> 0, offset);
  buffer.writeUInt32BE(fraction, offset + 4);
}

function readTimestamp(buffer: Buffer, offset: number): number {
  const seconds = buffer.readUInt32BE(offset);
  const fraction = buffer.readUInt32BE(offset + 4);
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction / 0x100000000) * 1000;
}

/** Asks one NTP server for the clock offset (server minus machine), in milliseconds. */
export function queryNtpOffset(
  server: string,
  { port = NTP_PORT, timeoutMs = NTP_TIMEOUT_MS, signal }: NtpOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = dgram.createSocket('udp4');
    const request = Buffer.alloc(48);
    request[0] = 0x23; // LI 0, version 4, mode 3 (client)
    const sentAt = Date.now();
    writeTimestamp(request, 40, sentAt);
    const sentStamp = request.subarray(40, 48);

    let settled = false;
    const abort = () => finish(new Error('NTP request aborted'));
    const finish = (error: Error | null, value?: number) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value as number);
    };
    const timer = setTimeout(() => finish(new Error(`NTP ${server} timed out`)), timeoutMs);

    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', (error) => finish(error));
    socket.on('message', (reply) => {
      const receivedAt = Date.now();
      if (reply.length < 48) return finish(new Error(`NTP ${server} sent a short reply`));
      const mode = reply[0] & 0x07;
      const stratum = reply[1];
      // The reply must answer this request and come from a synchronised server.
      if (mode !== 4 || stratum < 1 || stratum > 15 || !reply.subarray(24, 32).equals(sentStamp)) {
        return finish(new Error(`NTP ${server} sent an invalid reply`));
      }
      const serverReceived = readTimestamp(reply, 32);
      const serverSent = readTimestamp(reply, 40);
      finish(null, (serverReceived - sentAt + (serverSent - receivedAt)) / 2);
    });
    socket.send(request, port, server, (error) => {
      if (error) finish(error);
    });
  });
}

/** Syncs against the first server that answers; keeps the previous correction if none does. */
export async function syncClock(
  servers: string[] = NTP_SERVERS,
  options?: NtpOptions,
): Promise<boolean> {
  for (const server of servers) {
    if (options?.signal?.aborted) break;
    try {
      const nextOffset = await queryNtpOffset(server, options);
      if (options?.signal?.aborted) break;
      offsetMs = Math.round(nextOffset);
      lastSync = { server, at: new Date(Date.now() + offsetMs).toISOString(), offsetMs };
      return true;
    } catch {}
  }
  return false;
}

/** Syncs now and then hourly; failures are silent so the POS keeps working offline. */
export function startClockSync(getSignal: () => AbortSignal): () => void {
  const run = () => {
    void syncClock(NTP_SERVERS, { signal: getSignal() }).then((ok) => {
      if (ok) console.log(`[Clock] Synced with ${lastSync?.server} (offset ${offsetMs} ms)`);
    });
  };
  run();
  const timer = setInterval(run, NTP_RESYNC_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Test seam: resets the correction to the machine clock. */
export function resetClockForTests(): void {
  offsetMs = 0;
  lastSync = null;
}
