#!/usr/bin/env node
/*
 * Order throughput load test against a throwaway FloCafe test server.
 *
 * Starts tests/e2e-server.cjs on ports 4101-4103 with a fresh temporary database (never the shop's
 * flo.db), then simulates staff devices that each create an order, generate its bill and pay it,
 * while other devices poll the order list like the POS, KDS and Server App screens do.
 *
 * Requires a backend build first: npm run build
 *
 * Usage:
 *   node scripts/loadtest/order-load.cjs [--devices 4] [--minutes 2] [--pollers 3] [--items 3]
 *
 *   --devices   staff devices placing orders at the same time (default 4)
 *   --minutes   how long to run (default 2)
 *   --pollers   screens refreshing the order list every 2 seconds (default 3)
 *   --items     menu items per order (default 3)
 */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORTS = { api: 4101, kds: 4102, serverApp: 4103 };
const BASE = `http://127.0.0.1:${PORTS.api}`;
const LOGIN = { email: 'manager@flo.local', password: 'E2ePass123!' };
const POLL_INTERVAL_MS = 2000;

function readArgs() {
  const args = { devices: 4, minutes: 2, pollers: 3, items: 3 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = Number(argv[i + 1]);
    if (!(key in args) || !Number.isFinite(value) || value < 0) {
      console.error(`Unknown or invalid option: ${argv[i]} ${argv[i + 1] ?? ''}`);
      process.exit(2);
    }
    args[key] = value;
  }
  return args;
}

function startTestServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/e2e-server.cjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        E2E_BASE_URL: `http://127.0.0.1:${PORTS.api}`,
        E2E_KDS_BASE_URL: `http://127.0.0.1:${PORTS.kds}`,
        E2E_SERVER_APP_BASE_URL: `http://127.0.0.1:${PORTS.serverApp}`,
        FLO_ORDER_WRITE_RATE_LIMIT_MAX: '1000000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Test server did not start within 120s:\n${log.slice(-2000)}`));
    }, 120_000);
    const onData = (chunk) => {
      log += chunk;
      if (/\[E2E\] Main, KDS, and Server App servers ready/.test(log)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Test server exited with code ${code}:\n${log.slice(-2000)}`));
    });
  });
}

async function call(method, url, token, body) {
  const started = performance.now();
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = performance.now() - started;
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  return { ms, data: text ? JSON.parse(text) : null };
}

function cpuSnapshot() {
  return os.cpus().reduce(
    (sum, cpu) => {
      const t = cpu.times;
      sum.idle += t.idle;
      sum.total += t.user + t.nice + t.sys + t.irq + t.idle;
      return sum;
    },
    { idle: 0, total: 0 },
  );
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  const f = (n) => n.toFixed(0).padStart(6);
  return `${name.padEnd(16)} n=${String(sorted.length).padStart(6)}  avg${f(avg)} ms  p50${f(percentile(sorted, 50))} ms  p95${f(percentile(sorted, 95))} ms  max${f(sorted.at(-1) ?? 0)} ms`;
}

async function main() {
  const args = readArgs();
  console.log(
    `CPU: ${os.cpus()[0]?.model} x${os.cpus().length}  RAM: ${(os.totalmem() / 2 ** 30).toFixed(1)} GB`,
  );
  console.log(
    `Starting test server on ports ${Object.values(PORTS).join(', ')} (temporary database)...`,
  );
  const server = await startTestServer();
  const stop = () => server.exitCode === null && server.kill();
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  try {
    const login = await call('POST', '/api/auth/login', null, LOGIN);
    const token = login.data.access_token;
    if (!token) throw new Error('Login returned no access_token');

    const timings = { order: [], bill: [], payment: [], cycle: [], poll: [] };
    const errors = [];
    const endAt = Date.now() + args.minutes * 60_000;
    let completed = 0;

    const device = async () => {
      while (Date.now() < endAt) {
        const started = performance.now();
        try {
          const order = await call('POST', '/api/orders', token, {
            type: 'takeaway',
            items: Array.from({ length: Math.max(1, args.items) }, () => ({
              product_id: 'e2e-product',
              quantity: 1,
            })),
          });
          timings.order.push(order.ms);
          const bill = await call('POST', '/api/bills/generate', token, {
            order_id: order.data.order.id,
          });
          timings.bill.push(bill.ms);
          const paid = await call('POST', `/api/bills/${bill.data.bill.id}/payments`, token, {
            payments: [{ method: 'cash', amount: bill.data.bill.total }],
          });
          timings.payment.push(paid.ms);
          timings.cycle.push(performance.now() - started);
          completed++;
        } catch (error) {
          errors.push(error.message);
          if (errors.length >= 20) throw new Error(`Too many errors, first: ${errors[0]}`);
        }
      }
    };

    const poller = async () => {
      while (Date.now() < endAt) {
        try {
          timings.poll.push((await call('GET', '/api/orders?limit=50', token)).ms);
        } catch (error) {
          errors.push(error.message);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    };

    console.log(
      `Running ${args.minutes} min: ${args.devices} ordering devices, ${args.pollers} polling screens, ${args.items} items/order`,
    );
    const cpuBefore = cpuSnapshot();
    const wallStart = Date.now();
    const progress = setInterval(() => process.stdout.write(`  ${completed} orders paid\r`), 2000);
    await Promise.all([
      ...Array.from({ length: args.devices }, device),
      ...Array.from({ length: args.pollers }, poller),
    ]);
    clearInterval(progress);
    const wallMs = Date.now() - wallStart;
    const cpuAfter = cpuSnapshot();
    const cpuPercent =
      100 * (1 - (cpuAfter.idle - cpuBefore.idle) / (cpuAfter.total - cpuBefore.total || 1));

    console.log('\nResults');
    console.log(summarize('create order', timings.order));
    console.log(summarize('generate bill', timings.bill));
    console.log(summarize('pay bill', timings.payment));
    console.log(summarize('full order', timings.cycle));
    console.log(summarize('order list poll', timings.poll));
    const perHour = Math.round((completed / wallMs) * 3_600_000);
    console.log(`\nPaid orders: ${completed} in ${(wallMs / 1000).toFixed(0)} s`);
    console.log(`Throughput: ${perHour.toLocaleString()} orders/hour at full load`);
    console.log(`Machine CPU while running: ${cpuPercent.toFixed(0)}%`);
    console.log(`Errors: ${errors.length}${errors.length ? `  first: ${errors[0]}` : ''}`);
    console.log(
      '\nThis is the machine at full load with no pauses; printers, Wi-Fi and staff are slower in practice.',
    );
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
