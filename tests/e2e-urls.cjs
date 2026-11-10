function loopbackOrigin(value, variable) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.port ||
    url.port === '0' ||
    url.href !== `${url.origin}/`
  ) {
    throw new Error(`E2E ${variable} must be an HTTP loopback origin with an explicit port`);
  }
  return url.origin;
}

const E2E_BASE_URL = loopbackOrigin(
  process.env.E2E_BASE_URL || 'http://127.0.0.1:31101',
  'E2E_BASE_URL',
);
const E2E_KDS_BASE_URL = loopbackOrigin(
  process.env.E2E_KDS_BASE_URL ||
    (process.env.E2E_KDS_PORT
      ? `http://127.0.0.1:${process.env.E2E_KDS_PORT}`
      : process.env.KDS_BASE_URL || 'http://127.0.0.1:31102'),
  'E2E_KDS_BASE_URL',
);
const E2E_SERVER_APP_BASE_URL = loopbackOrigin(
  process.env.E2E_SERVER_APP_BASE_URL ||
    `http://127.0.0.1:${process.env.E2E_SERVER_APP_PORT || '31103'}`,
  'E2E_SERVER_APP_BASE_URL',
);

module.exports = { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL };
