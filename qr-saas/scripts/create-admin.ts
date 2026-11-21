import postgres from 'postgres';
import { createInvite } from '../apps/api/src/portal-auth';

const [email, name] = process.argv.slice(2).map((value) => value?.trim() ?? '');
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 100) {
  console.error('Usage: bun run scripts/create-admin.ts <email> "<display name>"');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
try {
  const [existing] = await sql`SELECT id, role FROM portal_users WHERE lower(email) = lower(${email})`;
  if (existing && existing.role !== 'admin') throw Error('That email belongs to a shop owner account.');
  const id = existing?.id ?? (await sql`
    INSERT INTO portal_users(email, display_name, role) VALUES (${email.toLowerCase()}, ${name}, 'admin') RETURNING id`)[0].id;
  await sql`UPDATE portal_users SET disabled_at = NULL WHERE id = ${id}`;
  const link = await createInvite(sql, id, process.env.PORTAL_PUBLIC_ORIGIN ?? 'https://order.aiwittaya.com', 'admin');
  console.log(`Administrator ${email}: open this link once within 7 days to set the password.\n${link}`);
} finally {
  await sql.end();
}
