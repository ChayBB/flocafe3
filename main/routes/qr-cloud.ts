import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../services/authorization';
import { rateLimit } from '../middleware/security';
import { QrCloudConfigError, hasConnectorToken, readConfig } from '../services/qr-cloud/config';
import {
  applyQrCloudConfig,
  clearQrCloudErrorHistory,
  getQrCloudDiagnostics,
  getQrCloudStatus,
  replaceQrCloudToken,
  revokeQrCloudToken,
  startQrCloudConnector,
  stopQrCloudConnector,
  testQrCloudConnection,
} from '../services/qr-cloud/connector';
import { inboxSummary, importLegacyInbox, InboxError } from '../services/qr-cloud/inbox';
import {
  CaCertificateError,
  approveCaCertificate,
  caStatus,
  inspectCaCertificate,
  removeApprovedCa,
} from '../services/qr-cloud/tls';

const router = Router();

const testLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

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
    return res.status(400).json({ error: error.code, code: error.code });
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
    has_token: hasConnectorToken(),
  };
}

router.get('/', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json({ config: sanitizedConfig(), status: getQrCloudStatus() });
});

router.put('/settings', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
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
    });
    res.json({ config: sanitizedConfig(), status: getQrCloudStatus() });
  } catch (error) {
    fail(res, error);
  }
});

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
  stopQrCloudConnector();
  res.json({ config: sanitizedConfig(), status: getQrCloudStatus() });
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
