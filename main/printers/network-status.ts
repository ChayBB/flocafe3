import net from 'net';
import { enqueuePrintJob, networkPrinterKey } from './print-queue';

/**
 * ESC/POS real-time status requests, answered one byte each and in order: `DLE EOT 4` (paper roll
 * sensor), then `DLE EOT 2` (why the printer is offline: cover open, stopped for paper end).
 */
export const PRINTER_STATUS_REQUEST = Buffer.from([0x10, 0x04, 0x04, 0x10, 0x04, 0x02]);
export const PRINTER_OUT_OF_PAPER_DETAIL = 'Printer is out of paper';
export const PRINTER_COVER_OPEN_DETAIL = 'Printer cover is open';

export type PrinterStatus = 'ok' | 'near_end' | 'paper_out' | 'cover_open';
export type PrinterProbeResult = PrinterStatus | 'no_answer' | 'unreachable';

/**
 * Tuning for raw TCP (port 9100) printing. `statusTimeoutMs` is how long a job waits for the
 * printer status before printing anyway (0 skips the check); `retryDelaysMs` are the pauses before
 * each new try when the printer refused or never answered the connection.
 */
export const networkPrintPolicy: {
  statusTimeoutMs: number;
  retryDelaysMs: number[];
} = {
  statusTimeoutMs: 300,
  retryDelaysMs: [500, 1000],
};

/** Keeps the bytes of a chunk that are real-time status replies (fixed bits 1 and 4 set, 0 and 7 clear). */
export function collectStatusBytes(into: number[], chunk: Buffer): void {
  for (const byte of chunk) if ((byte & 0x93) === 0x12) into.push(byte);
}

/**
 * Reads the replies to {@link PRINTER_STATUS_REQUEST}. A printer that answers only the paper request
 * is judged on that alone; one that answers nothing has no status.
 */
export function decodePrinterStatus(replies: number[]): PrinterStatus | null {
  const [paper, offline] = replies;
  if (paper === undefined) return null;
  if (paper & 0x60 || (offline !== undefined && offline & 0x20)) return 'paper_out';
  // With the cover open the paper sensor can still read a roll that cannot print.
  if (offline !== undefined && offline & 0x04) return 'cover_open';
  if (paper & 0x0c) return 'near_end';
  return 'ok';
}

/**
 * Asks a network printer for its status without printing anything. Runs in the printer's queue so
 * it never competes with a ticket for the printer's only connection.
 */
export function probeNetworkPrinter(
  ip: string,
  port: number,
  timeoutMs = 1500,
): Promise<PrinterProbeResult> {
  return enqueuePrintJob(
    networkPrinterKey(ip, port),
    () =>
      new Promise<PrinterProbeResult>((resolve) => {
        const client = new net.Socket();
        const replies: number[] = [];
        let settled = false;
        let connected = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.destroy();
          resolve(decodePrinterStatus(replies) ?? (connected ? 'no_answer' : 'unreachable'));
        };
        const timer = setTimeout(finish, timeoutMs);
        client.on('data', (chunk: Buffer) => {
          collectStatusBytes(replies, chunk);
          if (replies.length >= 2) finish();
        });
        client.on('error', finish);
        client.connect(port, ip, () => {
          connected = true;
          client.write(PRINTER_STATUS_REQUEST);
        });
      }),
    0,
  );
}
