# QR SaaS — Debian 13 / Elysia / Bun / Caddy / PostgreSQL / Redis

**Status: staging integration.** The core API, PostgreSQL outbox, scoped connector credentials and integrated FloCafe order delivery support testing. Real PromptPay verification, tenant-scoped staff RBAC and PostgreSQL RLS still need implementation before a production rollout. See `docs/CODEX_TASKS.md`.

## Quick start
1. Install Docker Compose on Debian 13: `sudo bash scripts/deploy-debian13.sh` (review firewall/SSH first).
2. `cp .env.example .env`; set `DOMAIN`, `QR_ORDERING_PUBLIC_ORIGIN`, a unique `ADMIN_BOOTSTRAP_TOKEN`, and independent DB/Redis passwords. Quote/URL-encode passwords as needed in connection URLs.
3. `docker compose build && docker compose up -d postgres redis`
4. `docker compose run --rm api bun run scripts/migrate.ts`
5. `docker compose up -d`; inspect `docker compose logs --tail=100`.
6. `curl https://YOUR_DOMAIN/health/ready`.
7. Register a branch installation at `POST /api/v1/admin/connector-installations/token` using the admin credential. Store the issued token in the integrated FloCafe connector. Enable `orders.read` and `orders.ack` for delivery, `tables.write` for Cloud stickers and `catalog.write` for menu publishing.

## Notes
- No card data is processed or stored. PromptPay integration is a Codex P0 task, not a working payment gateway.
- Cash confirmation route is a bootstrap example only; replace with authenticated branch-scoped staff permissions before launch.
- Cloud stickers use a public table ID. The guest session endpoint issues short-lived tokens for active POS tables without a manual opening step. POS synchronization repairs previously closed stickers. Ordering pauses only while a printed bill awaits cashier receipt confirmation.
- `outbox_events` are durably handed off to `connector_deliveries`; Redis Pub/Sub is only an optimization.
- Never expose PostgreSQL or Redis ports to the Internet.
- Backups: `bash scripts/backup.sh`, encrypt and send offsite, test restore. Local backups alone are insufficient.
- Keep `ALLOW_LEGACY_CONNECTOR_TOKEN=false` for registered installations. The transitional legacy token only supports reading orders and table QR management before a branch has registered an installation.
- Pin dependency versions/digests and generate/commit `bun.lock` in CI before production deployment.

## Mobile menu preview

Use one staging table with menu items in the same tenant and branch. Call
`POST /api/v1/admin/table-menu-previews` with the existing admin bearer credential
and the table's `tenant_id`, `branch_id`, and `table_id`. The response contains
`preview_path` and `expires_at`. Prefix the path with the public HTTPS origin
and keep the complete fragment after `#`. The fragment contains a read-only
credential valid for three hours, or until the table session is revoked.

Pipe the complete URL to `node qr-saas/scripts/menu-preview-qr.cjs` from the
FloCafe checkout with its dependencies installed. The command creates
`menu-preview-qr.png` in the current directory. Scan that QR on the test phone
and check the table name, menu, and prices. The preview reads the Cloud catalog
without creating orders or Connector events. Use an HTTPS hostname and
certificate the test phone can resolve and trust.

## Connector notifications

Connect to `wss://YOUR_DOMAIN/api/v1/connectors/notifications` with the same
`Authorization: Bearer <connector token>` header as HTTPS polling. The server
uses the configured connector tenant and branch. Query parameters do not select
credentials or scope.

The server sends one kind of data frame:

```json
{"type":"order.available","version":1,"event_id":"…","delivery_id":"…","order_id":"…"}
```

`delivery_id` is the delivery row's primary key, which is `event_id` in this
schema. Treat the message as a hint to fetch pending work with
`GET /api/v1/connectors/events`. Keep that HTTPS poll running as the fallback
and deduplicate work by event ID. A reconnect can replay pending events.
The registered connector uses `POST /api/v1/connectors/ack-receipt` after POS persistence. Replaying the same receipt returns the same result.

The relay checks PostgreSQL on connect, on a Redis wake-up, and every five
seconds while connected. It considers the oldest 64 eligible pending events
at a time. The server uses WebSocket ping/pong and closes slow connections
so they can resume via polling. Caddy proxies upgrades and keeps credentials
out of access logs.

The notification tests run with `bun test`. To also run the SQL integration
test, set `QR_NOTIFICATION_TEST_DATABASE_URL` to a loopback PostgreSQL database
ending in `_test`. The test uses temporary tables that are dropped at commit.
