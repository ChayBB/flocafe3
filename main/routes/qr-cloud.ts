import { Router, type Request, type Response } from 'express';
import * as QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db';
import { getHttpRequestSignal } from '../shutdown';
import { requirePermission } from '../services/authorization';
import { rateLimit } from '../middleware/security';
import {
  QrCloudConfigError,
  hasConnectorToken,
  readConfig,
  readConnectorSetting,
} from '../services/qr-cloud/config';
import {
  applyQrCloudConfig,
  clearQrCloudErrorHistory,
  getQrCloudDiagnostics,
  getQrCloudStatus,
  replaceQrCloudToken,
  revokeQrCloudToken,
  startQrCloudConnector,
  testQrCloudConnection,
} from '../services/qr-cloud/connector';
import { inboxSummary, importLegacyInbox, InboxError } from '../services/qr-cloud/inbox';
import {
  CONNECTOR_EVENT_ID,
  connectorCatalog,
  manageConnectorTableQr,
  QrCloudClientError,
  readConnectorCapabilities,
} from '../services/qr-cloud/client';
import { buildCloudCatalog } from '../services/qr-cloud/catalog';
import {
  acceptCloudOrder,
  CloudOrderError,
  pendingCloudOrders,
  previewCloudOrder,
} from '../services/qr-cloud/order-acceptance';
import {
  approveLegacyCutover,
  activateQrCloudSetup,
  commitLegacyImport,
  importLegacyCa,
  LegacyImportError,
  previewLegacyImport,
} from '../services/qr-cloud/legacy-import';
import {
  CaCertificateError,
  approveCaCertificate,
  caStatus,
  inspectCaCertificate,
  readApprovedCa,
  removeApprovedCa,
} from '../services/qr-cloud/tls';

const router = Router();

const testLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const inboxOrderLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

/**
 * Bearer-token API with no cookie session, so cross-site requests cannot authenticate. A present
 * Origin must still be a loopback application origin; anything else is refused for mutations.
 */
router.use((req: Request, res: Response, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const { hostname } = new URL(origin);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) return next();
  } catch {
    // Fall through to the refusal below.
  }
  return res.status(403).json({ error: 'Origin not allowed', code: 'origin_not_allowed' });
});

function fail(res: Response, error: unknown) {
  if (error instanceof QrCloudConfigError) {
    const status = error.code === 'credential_storage_unavailable' ? 503 : 400;
    return res.status(status).json({ error: error.code, code: error.code });
  }
  if (error instanceof CaCertificateError) {
    return res.status(400).json({ error: error.code, code: error.code });
  }
  if (error instanceof InboxError) {
    const status = error.code === 'import_source_missing' ? 404 : 400;
    return res.status(status).json({ error: error.code, code: error.code });
  }
  console.error('[API] QR cloud connector error:', error);
  return res.status(500).json({ error: 'Internal server error' });
}

function inboxOrderFailure(res: Response, error: unknown) {
  if (error instanceof CloudOrderError) return res.status(error.status).json({ code: error.code });
  if (error instanceof QrCloudClientError) {
    const code = error.detail === 'HTTP 404' ? 'cloud_order_unavailable' : error.code;
    return res.status(error.code === 'timeout' ? 504 : 502).json({ code });
  }
  return res.status(500).json({ code: 'inbox_order_failed' });
}

router.get(
  '/inbox/orders',
  requirePermission('settings.manage'),
  requirePermission('orders.create'),
  (_req, res) => {
    try {
      return res.json({ events: pendingCloudOrders() });
    } catch (error) {
      return inboxOrderFailure(res, error);
    }
  },
);

router.get(
  '/inbox/orders/:id',
  requirePermission('settings.manage'),
  requirePermission('orders.create'),
  inboxOrderLimiter,
  async (req, res) => {
    try {
      return res.json(await previewCloudOrder(req, String(req.params.id)));
    } catch (error) {
      return inboxOrderFailure(res, error);
    }
  },
);

router.post(
  '/inbox/orders/:id/accept',
  requirePermission('settings.manage'),
  requirePermission('orders.create'),
  inboxOrderLimiter,
  async (req, res) => {
    try {
      if (req.body?.confirmed !== true)
        return res.status(400).json({ code: 'confirmation_required' });
      const actor = (req as Request & { user: { userId: string } }).user.userId;
      return res.json(
        await acceptCloudOrder(req, String(req.params.id), String(actor), req.body.table_id),
      );
    } catch (error) {
      return inboxOrderFailure(res, error);
    }
  },
);

router.get(
  '/table-qr',
  requirePermission('settings.manage'),
  requirePermission('tables.manage'),
  (_req, res) => {
    const tables = getDatabase()
      .prepare('SELECT id, number, is_active FROM tables ORDER BY number, id')
      .all() as { id: string; number: string; is_active: number }[];
    return res.json({
      tables: tables.map((table) => ({ ...table, is_active: table.is_active === 1 })),
    });
  },
);

router.get(
  '/catalog',
  requirePermission('settings.manage'),
  requirePermission('catalog.manage'),
  (_req, res) => {
    try {
      const { items, fingerprint } = buildCloudCatalog();
      return res.json({ count: items.length, fingerprint });
    } catch (error) {
      return inboxOrderFailure(res, error);
    }
  },
);

router.post(
  '/catalog',
  requirePermission('settings.manage'),
  requirePermission('catalog.manage'),
  testLimiter,
  async (req, res) => {
    try {
      if (req.body?.confirmed !== true)
        return res.status(400).json({ code: 'confirmation_required' });
      const { items, fingerprint } = buildCloudCatalog();
      if (req.body.fingerprint !== fingerprint)
        return res.status(409).json({ code: 'catalog_changed' });
      const config = readConfig();
      if (!config.enabled || config.mode !== 'integrated' || config.cutoverPending) {
        return res.status(409).json({ code: 'connector_inactive' });
      }
      const token = readConnectorSetting();
      const options = {
        config,
        token,
        caPem: readApprovedCa()?.pem,
        signal: AbortSignal.timeout(config.timeoutMs),
      };
      const current = (await connectorCatalog(options)) as { revision?: string | null } | null;
      if (
        !current ||
        (current.revision !== null &&
          (typeof current.revision !== 'string' || !CONNECTOR_EVENT_ID.test(current.revision)))
      ) {
        return res.status(502).json({ code: 'invalid_catalog_revision' });
      }
      const latest = readConfig();
      if (
        !latest.enabled ||
        latest.mode !== 'integrated' ||
        latest.cutoverPending ||
        latest.cloudUrl !== config.cloudUrl ||
        readConnectorSetting() !== token
      ) {
        return res.status(409).json({ code: 'connector_changed' });
      }
      const revision = randomUUID();
      const published = (await connectorCatalog(options, {
        revision,
        base_revision: current.revision,
        items,
      })) as { revision?: string; count?: number } | null;
      if (published?.revision !== revision || published.count !== items.length) {
        return res.status(502).json({ code: 'invalid_catalog_revision' });
      }
      return res.json(published);
    } catch (error) {
      return inboxOrderFailure(res, error);
    }
  },
);

router.post(
  '/table-qr',
  requirePermission('settings.manage'),
  requirePermission('tables.manage'),
  testLimiter,
  async (req, res) => {
    const { action, table_id: tableId, all_tables: allTables, confirmed } = req.body ?? {};
    if (
      (action !== 'open' && action !== 'close') ||
      (allTables === true
        ? tableId !== undefined
        : typeof tableId !== 'string' || !tableId || tableId.length > 128)
    ) {
      return res.status(400).json({ code: 'invalid_pos_table' });
    }
    if (allTables === true && confirmed !== true)
      return res.status(400).json({ code: 'confirmation_required' });
    try {
      type PosTable = { id: string; number: string };
      const db = getDatabase();
      const tables =
        allTables === true
          ? (db
              .prepare(
                "SELECT id, number FROM tables WHERE ? = 'close' OR is_active = 1 ORDER BY number, id",
              )
              .all(action) as PosTable[])
          : [
              db
                .prepare(
                  "SELECT id, number FROM tables WHERE id = ? AND (? = 'close' OR is_active = 1)",
                )
                .get(tableId, action) as PosTable | undefined,
            ].filter((table): table is PosTable => table !== undefined);
      if (!tables.length) return res.status(404).json({ code: 'invalid_pos_table' });
      const config = readConfig();
      if (
        config.mode !== 'integrated' ||
        config.cutoverPending ||
        (action === 'open' && !config.enabled)
      ) {
        return res.status(409).json({ code: 'connector_inactive' });
      }
      const requestSignal = getHttpRequestSignal(req);
      const token = readConnectorSetting();
      const caPem = readApprovedCa()?.pem;
      async function apply(table: PosTable) {
        const deadline = AbortSignal.timeout(config.timeoutMs);
        const signal = requestSignal ? AbortSignal.any([deadline, requestSignal]) : deadline;
        const result = (await manageConnectorTableQr(
          { config, token, caPem, signal },
          { action, pos_table_id: table.id, name: table.number },
        )) as { closed?: unknown; url?: unknown; expires_at?: unknown } | null;
        if (action === 'close' && result?.closed === true) return { closed: true };
        const url = typeof result?.url === 'string' ? URL.parse(result.url) : null;
        if (
          action !== 'open' ||
          !url ||
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          !url.hash.startsWith('#table=') ||
          !CONNECTOR_EVENT_ID.test(url.hash.slice(7)) ||
          typeof result?.expires_at !== 'string' ||
          !Number.isFinite(Date.parse(result.expires_at))
        ) {
          throw new CloudOrderError('invalid_cloud_table_qr', 502);
        }
        const data_url = await QRCode.toDataURL(url.href, {
          width: 360,
          margin: 4,
          errorCorrectionLevel: 'M',
        });
        return { data_url, url: url.href, expires_at: result.expires_at };
      }
      if (allTables !== true) return res.json(await apply(tables[0]));

      const results = [];
      for (let index = 0; index < tables.length && !requestSignal?.aborted; index += 5) {
        results.push(
          ...(await Promise.all(
            tables.slice(index, index + 5).map(async (table) => {
              try {
                return { ...table, ...(await apply(table)) };
              } catch (error) {
                return {
                  ...table,
                  code:
                    error instanceof QrCloudClientError || error instanceof CloudOrderError
                      ? error.code
                      : 'cloud_table_qr_failed',
                };
              }
            }),
          )),
        );
      }
      return res.json({ tables: results });
    } catch (error) {
      if (error instanceof CloudOrderError)
        return res.status(error.status).json({ code: error.code });
      if (error instanceof QrCloudClientError) {
        return res.status(error.code === 'timeout' ? 504 : 502).json({ code: error.code });
      }
      return res.status(500).json({ code: 'cloud_table_qr_failed' });
    }
  },
);

function legacyAction(
  fields: string[],
  action: (actor: string, body: Record<string, unknown>) => unknown,
) {
  return async (req: Request, res: Response) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      return res.status(403).json({ code: 'legacy_loopback_required' });
    }
    const body: unknown = req.body ?? {};
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !fields.includes(key))
    ) {
      return res.status(400).json({ code: 'legacy_request_invalid' });
    }
    try {
      const actor = (req as Request & { user: { userId: string } }).user.userId;
      const result = await action(String(actor), body as Record<string, unknown>);
      return res.json(result);
    } catch (error) {
      if (error instanceof LegacyImportError)
        return res.status(error.status).json({ code: error.code });
      if (error instanceof QrCloudConfigError || error instanceof CaCertificateError)
        return fail(res, error);
      return res.status(500).json({ code: 'legacy_import_failed' });
    }
  };
}

/** Sanitized configuration: the token is reported as present or absent, never returned. */
function sanitizedConfig() {
  const config = readConfig();
  return {
    enabled: config.enabled,
    mode: config.mode,
    cloud_url: config.cloudUrl,
    connection_mode: config.connectionMode,
    poll_interval_ms: config.pollIntervalMs,
    auto_start: config.autoStart,
    retry_max: config.retryMax,
    timeout_ms: config.timeoutMs,
    reconcile_interval_ms: config.reconcileIntervalMs,
    cutover_pending: config.cutoverPending,
    acceptance_mode: config.automaticSince ? 'automatic' : 'manual',
    has_token: hasConnectorToken(),
  };
}

router.get('/', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json({ config: sanitizedConfig(), status: getQrCloudStatus() });
});

router.post(
  '/legacy-import/preview',
  requirePermission('settings.manage'),
  legacyAction([], (actor) => previewLegacyImport(actor)),
);

router.post(
  '/legacy-import/commit',
  requirePermission('settings.manage'),
  legacyAction(['preview_id', 'confirm', 'replace_credential'], (actor, body) => {
    commitLegacyImport(actor, body);
    return { imported: true, cutover_pending: true };
  }),
);

router.post(
  '/legacy-import/ca',
  requirePermission('settings.manage'),
  legacyAction(['confirm', 'expected_fingerprint'], (_actor, body) => {
    importLegacyCa(body);
    return caStatus();
  }),
);

router.post(
  '/legacy-import/cutover',
  requirePermission('settings.manage'),
  testLimiter,
  legacyAction(['confirm_legacy_stopped'], (actor, body) =>
    approveLegacyCutover(actor, body.confirm_legacy_stopped),
  ),
);

router.post(
  '/activate',
  requirePermission('settings.manage'),
  testLimiter,
  legacyAction(['confirm_legacy_stopped'], async (actor, body) => {
    const test = await activateQrCloudSetup(actor, body.confirm_legacy_stopped);
    return { ...test, config: sanitizedConfig(), status: getQrCloudStatus() };
  }),
);

router.put(
  '/settings',
  requirePermission('settings.manage'),
  async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (
        body.acceptance_mode !== undefined &&
        body.acceptance_mode !== 'manual' &&
        body.acceptance_mode !== 'automatic'
      ) {
        return res.status(400).json({ code: 'acceptance_mode_invalid' });
      }
      if (body.acceptance_mode === 'automatic') {
        const current = readConfig();
        if (body.confirm_automatic !== true)
          return res.status(400).json({ code: 'confirmation_required' });
        if (
          !current.enabled ||
          current.mode !== 'integrated' ||
          current.cutoverPending ||
          !current.cloudUrl ||
          !hasConnectorToken()
        ) {
          return res.status(409).json({ code: 'connector_inactive' });
        }
        const token = readConnectorSetting();
        const capabilities = (await readConnectorCapabilities({
          config: current,
          token,
          caPem: readApprovedCa()?.pem,
          signal: AbortSignal.timeout(current.timeoutMs),
        }).catch(() => null)) as { automatic_acceptance?: boolean } | null;
        const latest = readConfig();
        if (
          !capabilities?.automatic_acceptance ||
          latest.cloudUrl !== current.cloudUrl ||
          !latest.enabled ||
          latest.mode !== 'integrated' ||
          latest.cutoverPending ||
          readConnectorSetting() !== token
        ) {
          return res.status(409).json({ code: 'automatic_delivery_unavailable' });
        }
      }
      applyQrCloudConfig({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        mode: body.mode,
        cloudUrl: typeof body.cloud_url === 'string' ? body.cloud_url : undefined,
        connectionMode: body.connection_mode,
        pollIntervalMs: body.poll_interval_ms,
        autoStart: typeof body.auto_start === 'boolean' ? body.auto_start : undefined,
        retryMax: body.retry_max,
        timeoutMs: body.timeout_ms,
        reconcileIntervalMs: body.reconcile_interval_ms,
        automatic:
          body.acceptance_mode === undefined ? undefined : body.acceptance_mode === 'automatic',
      });
      res.json({ config: sanitizedConfig(), status: getQrCloudStatus() });
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post('/token', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    replaceQrCloudToken(req.body?.token);
    res.json({ has_token: hasConnectorToken(), status: getQrCloudStatus() });
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/token', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  revokeQrCloudToken();
  res.json({ has_token: false, status: getQrCloudStatus() });
});

router.post(
  '/test',
  requirePermission('settings.manage'),
  testLimiter,
  async (_req: Request, res: Response) => {
    try {
      res.json(await testQrCloudConnection());
    } catch (error) {
      fail(res, error);
    }
  },
);

router.post('/retry', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  const config = readConfig();
  if (config.enabled) startQrCloudConnector({ force: true });
  res.json({ status: getQrCloudStatus() });
});

router.post('/enable', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  try {
    applyQrCloudConfig({ enabled: true });
    res.json({ config: sanitizedConfig(), status: getQrCloudStatus() });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/disable', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  try {
    applyQrCloudConfig({ enabled: false });
    res.json({ config: sanitizedConfig(), status: getQrCloudStatus() });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/diagnostics', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json(getQrCloudDiagnostics());
});

router.delete(
  '/diagnostics/errors',
  requirePermission('settings.manage'),
  (_req: Request, res: Response) => {
    res.json({ cleared: clearQrCloudErrorHistory() });
  },
);

router.get('/inbox', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json({ inbox: inboxSummary() });
});

/**
 * Imports an existing standalone Connector inbox. The source is read-only, a backup copy is
 * written first, and the caller must confirm: nothing is migrated implicitly at startup.
 */
router.post(
  '/inbox/import',
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      if (req.body?.confirm !== true)
        return res
          .status(400)
          .json({ error: 'confirmation_required', code: 'confirmation_required' });
      const source = req.body?.source_path;
      if (typeof source !== 'string' || !source.trim())
        return res
          .status(400)
          .json({ error: 'source_path_required', code: 'source_path_required' });
      res.json(importLegacyInbox(source));
    } catch (error) {
      fail(res, error);
    }
  },
);

router.get('/ca', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json(caStatus());
});

/** Inspect a certificate without trusting it: subject, issuer, validity and fingerprint only. */
router.post('/ca/inspect', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const certificate = req.body?.certificate;
    if (typeof certificate !== 'string')
      return res.status(400).json({ error: 'certificate_required', code: 'certificate_required' });
    const info = inspectCaCertificate(certificate);
    res.json({
      subject: info.subject,
      issuer: info.issuer,
      valid_from: info.valid_from,
      valid_to: info.valid_to,
      fingerprint_sha256: info.fingerprint_sha256,
      is_ca: info.is_ca,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/ca', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const certificate = req.body?.certificate;
    const expected = req.body?.expected_fingerprint;
    if (typeof certificate !== 'string' || typeof expected !== 'string')
      return res.status(400).json({ error: 'certificate_and_fingerprint_required' });
    approveCaCertificate({
      certificate,
      expected_fingerprint: expected,
      confirm: req.body?.confirm === true,
    });
    res.json(caStatus());
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/ca', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  removeApprovedCa();
  res.json(caStatus());
});

export { router as qrCloudRoutes };
