import net from 'net';
import { enqueuePrintJob, networkPrinterKey } from './print-queue';

/** ESC/POS real-time status request `DLE EOT 4`: the paper roll sensor. */
export const PAPER_STATUS_REQUEST = Buffer.from([0x10, 0x04, 0x04]);
export const PRINTER_OUT_OF_PAPER_DETAIL = 'Printer is out of paper';

export type PaperStatus = 'ok' | 'near_end' | 'paper_out';
export type PrinterProbeResult = PaperStatus | 'no_answer' | 'unreachable';

/**
 * Tuning for raw TCP (port 9100) printing. `statusTimeoutMs` is how long a job waits for the paper
 * status before printing anyway (0 skips the check); `retryDelaysMs` are the pauses before each new
 * try when the printer refused or never answered the connection.
 */
export const networkPrintPolicy: {
  statusTimeoutMs: number;
  retryDelaysMs: number[];
} = {
  statusTimeoutMs: 300,
  retryDelaysMs: [500, 1000],
};

/** Reads a `DLE EOT 4` reply; anything without the fixed bit pattern is not one. */
export function parsePaperStatusByte(byte: number): PaperStatus | null {
  if ((byte & 0x93) !== 0x12) return null;
  if (byte & 0x60) return 'paper_out';
  if (byte & 0x0c) return 'near_end';
  return 'ok';
}

export function findPaperStatus(chunk: Buffer): PaperStatus | null {
  for (const byte of chunk) {
    const status = parsePaperStatusByte(byte);
    if (status) return status;
  }
  return null;
}

/**
 * Asks a network printer for its paper status without printing anything. Runs in the printer's
 * queue so it never competes with a ticket for the printer's only connection.
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
        let settled = false;
        let connected = false;
        const finish = (result: PrinterProbeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.destroy();
          resolve(result);
        };
        const timer = setTimeout(() => finish(connected ? 'no_answer' : 'unreachable'), timeoutMs);
        client.on('data', (chunk: Buffer) => {
          const status = findPaperStatus(chunk);
          if (status) finish(status);
        });
        client.on('error', () => finish(connected ? 'no_answer' : 'unreachable'));
        client.connect(port, ip, () => {
          connected = true;
          client.write(PAPER_STATUS_REQUEST);
        });
      }),
    0,
  );
}
