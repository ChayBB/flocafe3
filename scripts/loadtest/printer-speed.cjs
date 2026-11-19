#!/usr/bin/env node
/*
 * Times a network receipt printer (ESC/POS on TCP port 9100) printing kitchen-ticket-sized slips.
 *
 * Sends the tickets back to back, then asks you to press Enter the moment the last one has been
 * cut: the printer buffers data, so only the paper coming out shows the real printing speed.
 * Prints real paper, so use a test roll or expect to throw the slips away.
 *
 * Usage:
 *   node scripts/loadtest/printer-speed.cjs [printer-ip] [--count 5] [--lines 20] [--port 9100] [--no-wait]
 *
 *   printer-ip defaults to the shop's kitchen printer, 192.168.123.100
 *   --count   tickets to print (default 5)
 *   --lines    item lines per ticket (default 20, about one long kitchen ticket)
 *   --no-wait  skip the Enter prompt and report only how fast the printer accepted the data
 */
const net = require('node:net');
const readline = require('node:readline');

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const EOT = 0x04;
const DEFAULT_PRINTER_IP = '192.168.123.100';

function readArgs() {
  const argv = process.argv.slice(2);
  const args = { host: '', count: 5, lines: 20, port: 9100, wait: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-wait') args.wait = false;
    else if (['--count', '--lines', '--port'].includes(arg)) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) usage(`Invalid value for ${arg}`);
      args[arg.slice(2)] = value;
    } else if (!arg.startsWith('--') && !args.host) args.host = arg;
    else usage(`Unknown option: ${arg}`);
  }
  args.host ||= DEFAULT_PRINTER_IP;
  if (!net.isIP(args.host)) usage(`Not an IP address: ${args.host}`);
  return args;
}

function usage(message) {
  console.error(message);
  console.error(
    'Usage: node scripts/loadtest/printer-speed.cjs [printer-ip] [--count 5] [--lines 20] [--port 9100] [--no-wait]',
  );
  process.exit(2);
}

function ticket(number, total, lines) {
  const parts = [Buffer.from([ESC, 0x40])];
  const text = (line) => parts.push(Buffer.from(`${line}\n`, 'ascii'));
  parts.push(Buffer.from([ESC, 0x61, 1, GS, 0x21, 0x11]));
  text(`TEST TICKET ${number}/${total}`);
  parts.push(Buffer.from([GS, 0x21, 0x00, ESC, 0x61, 0]));
  text(`Table 12            ${new Date().toLocaleTimeString('en-GB')}`);
  text('--------------------------------');
  for (let i = 1; i <= lines; i++)
    text(`${String(i).padStart(2)} x Test menu item ${i}`.padEnd(32));
  text('--------------------------------');
  parts.push(Buffer.from([ESC, 0x64, 4, GS, 0x56, 0x42, 0x00]));
  return Buffer.concat(parts);
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(10_000, () => socket.destroy(new Error(`No answer from ${host}:${port}`)));
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function write(socket, data) {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/** DLE EOT 1: a real-time status byte, answered even while the printer is still printing. */
function queryStatus(socket) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    socket.once('data', (data) => {
      clearTimeout(timer);
      resolve(data[0]);
    });
    socket.write(Buffer.from([DLE, EOT, 1]));
  });
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, () => {
      rl.close();
      resolve();
    }),
  );
}

async function main() {
  const args = readArgs();
  console.log(`Connecting to ${args.host}:${args.port}...`);
  const connectStart = performance.now();
  const socket = await connect(args.host, args.port);
  console.log(`Connected in ${(performance.now() - connectStart).toFixed(0)} ms`);
  const status = await queryStatus(socket);
  console.log(
    status === null
      ? 'Printer did not answer the status query (some models do not); continuing'
      : `Printer status byte: 0x${status.toString(16).padStart(2, '0')}`,
  );
  if (args.wait) await waitForEnter(`Press Enter to print ${args.count} tickets...`);

  const tickets = Array.from({ length: args.count }, (_, i) =>
    ticket(i + 1, args.count, args.lines),
  );
  const bytes = tickets.reduce((sum, t) => sum + t.length, 0);
  const start = performance.now();
  for (const [index, data] of tickets.entries()) {
    await write(socket, data);
    console.log(
      `  ticket ${index + 1} accepted at ${((performance.now() - start) / 1000).toFixed(2)} s`,
    );
  }
  const acceptedSeconds = (performance.now() - start) / 1000;
  console.log(
    `Printer accepted ${args.count} tickets (${(bytes / 1024).toFixed(1)} KB) in ${acceptedSeconds.toFixed(2)} s`,
  );

  if (args.wait) {
    await waitForEnter('Press Enter the moment the LAST ticket is cut...');
    const printedSeconds = (performance.now() - start) / 1000;
    const perTicket = printedSeconds / args.count;
    console.log(`\nPrinted ${args.count} tickets in ${printedSeconds.toFixed(1)} s`);
    console.log(`About ${perTicket.toFixed(1)} s per ticket of ${args.lines} lines`);
    console.log(
      `About ${Math.floor(3600 / perTicket).toLocaleString()} tickets/hour from this printer`,
    );
  } else {
    console.log('Without the Enter timing this only shows the printer buffer, not printing speed.');
  }
  socket.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
