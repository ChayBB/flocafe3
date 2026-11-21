import type { Sql } from 'postgres';
import { sha256, token } from '../../../packages/shared/src/index';

export const SESSION_COOKIE = 'flo_portal';
export const SESSION_HOURS = 12;
export const INVITE_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 10;
/** Mutations must carry this header: a cross-site form cannot set it without a CORS preflight. */
export const PORTAL_HEADER = 'x-flo-portal';

export interface PortalUser {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'owner';
  tenant_id: string | null;
}

const DUMMY_HASH = await Bun.password.hash('flo-portal-timing-equalizer', 'argon2id');

export const hashPassword = (password: string) => Bun.password.hash(password, 'argon2id');

export function sessionCookie(value: string, maxAgeSeconds: number) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function readSessionCookie(request: Request): string {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return '';
}

/** Verifies an email or username and password in constant work whether or not the account exists. */
export async function verifyLogin(sql: Sql, login: string, password: string): Promise<PortalUser | null> {
  const [row] = await sql`
    SELECT id, email, display_name, role, tenant_id, password_hash FROM portal_users
    WHERE (lower(email) = lower(${login}) OR username = lower(${login})) AND disabled_at IS NULL`;
  const ok = await Bun.password.verify(password, row?.password_hash ?? DUMMY_HASH);
  if (!row?.password_hash || !ok) return null;
  const { password_hash: _hash, ...user } = row;
  return user as PortalUser;
}

export async function createSession(sql: Sql, userId: string) {
  const secret = token();
  await sql`INSERT INTO portal_sessions(token_hash, user_id, expires_at)
    VALUES (${sha256(secret)}, ${userId}, now() + make_interval(hours => ${SESSION_HOURS}))`;
  return secret;
}

export async function sessionUser(sql: Sql, request: Request): Promise<PortalUser | null> {
  const secret = readSessionCookie(request);
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(secret)) return null;
  const [row] = await sql<PortalUser[]>`
    SELECT u.id, u.email, u.display_name, u.role, u.tenant_id FROM portal_sessions s
    JOIN portal_users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(secret)} AND s.expires_at > now() AND u.disabled_at IS NULL`;
  return row ?? null;
}

export async function endSession(sql: Sql, request: Request) {
  const secret = readSessionCookie(request);
  if (secret) await sql`DELETE FROM portal_sessions WHERE token_hash = ${sha256(secret)}`;
}

/** A one-time link to set (or reset) the password; earlier unused links for the user stop working. */
export async function createInvite(sql: Sql, userId: string, publicOrigin: string, role: 'admin' | 'owner') {
  const secret = token();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM portal_invites WHERE user_id = ${userId} AND used_at IS NULL`;
    await tx`INSERT INTO portal_invites(token_hash, user_id, expires_at)
      VALUES (${sha256(secret)}, ${userId}, now() + make_interval(days => ${INVITE_DAYS}))`;
  });
  const page = role === 'owner' ? '/customer/login' : '/admin/login';
  return `${publicOrigin.replace(/\/+$/, '')}${page}#invite=${secret}`;
}

/** Sets the password from an invite, signs out the user's other sessions and returns the user. */
export async function acceptInvite(sql: Sql, secret: string, password: string): Promise<PortalUser | null> {
  const passwordHash = await hashPassword(password);
  return sql.begin(async (tx) => {
    const [invite] = await tx`
      UPDATE portal_invites SET used_at = now()
      WHERE token_hash = ${sha256(secret)} AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`;
    if (!invite) return null;
    const [user] = await tx<PortalUser[]>`
      UPDATE portal_users SET password_hash = ${passwordHash}
      WHERE id = ${invite.user_id} AND disabled_at IS NULL
      RETURNING id, email, display_name, role, tenant_id`;
    if (!user) return null;
    await tx`DELETE FROM portal_sessions WHERE user_id = ${user.id}`;
    return user;
  }) as Promise<PortalUser | null>;
}

export async function audit(
  sql: Sql,
  entry: { userId: string | null; action: string; tenantId?: string | null; branchId?: string | null; detail?: Record<string, unknown> },
) {
  await sql`INSERT INTO portal_audit(user_id, action, tenant_id, branch_id, detail)
    VALUES (${entry.userId}, ${entry.action}, ${entry.tenantId ?? null}, ${entry.branchId ?? null}, ${sql.json((entry.detail ?? {}) as never)})`;
}
