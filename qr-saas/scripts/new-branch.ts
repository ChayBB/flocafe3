import postgres from 'postgres';
import { createPairingCode, PAIRING_TTL_MINUTES } from '../apps/api/src/pairing';

const usage = `Register a shop branch and print a one-time POS pairing code.

  bun run scripts/new-branch.ts "<shop name>" "<branch name>"     new shop with its first branch
  bun run scripts/new-branch.ts --tenant <tenant-id> "<branch name>"  another branch of a shop
  bun run scripts/new-branch.ts --branch <branch-id>               new code for a branch (new or replaced POS)
  bun run scripts/new-branch.ts --list                             list shops and branches`;

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
};
const name = (value: string | undefined, what: string) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > 100) fail(`Give the ${what} (1-100 characters).`);
  return trimmed;
};

const sql = postgres(process.env.DATABASE_URL ?? fail('DATABASE_URL is not set.'), { max: 1, onnotice: () => {} });
try {
  if (args[0] === '--list') {
    const rows = await sql`
      SELECT t.id AS tenant_id, t.name AS shop, b.id AS branch_id, b.name AS branch,
             EXISTS (SELECT 1 FROM connector_installations c
                     WHERE c.tenant_id = b.tenant_id AND c.branch_id = b.id AND c.revoked_at IS NULL) AS has_pos
      FROM tenants t LEFT JOIN branches b ON b.tenant_id = t.id
      ORDER BY t.created_at, b.created_at`;
    for (const row of rows)
      console.log(`${row.shop} | ${row.branch ?? '-'} | tenant ${row.tenant_id} | branch ${row.branch_id ?? '-'} | POS ${row.has_pos ? 'paired' : 'none'}`);
  } else {
    let tenantId: string;
    let branchId: string;
    if (args[0] === '--branch') {
      if (!UUID.test(args[1] ?? '')) fail('Give the branch id from --list.');
      const [branch] = await sql`SELECT tenant_id, id FROM branches WHERE id = ${args[1]}`;
      if (!branch) fail('No branch has that id.');
      ({ tenant_id: tenantId, id: branchId } = branch);
    } else {
      const created = await sql.begin(async (tx) => {
        let tenant: string;
        if (args[0] === '--tenant') {
          if (!UUID.test(args[1] ?? '')) fail('Give the tenant id from --list.');
          const [row] = await tx`SELECT id FROM tenants WHERE id = ${args[1]}`;
          if (!row) fail('No shop has that tenant id.');
          tenant = row.id;
        } else {
          const shop = name(args[0], 'shop name');
          const [existing] = await tx`SELECT id FROM tenants WHERE name = ${shop}`;
          if (existing) fail(`A shop named "${shop}" already exists (tenant ${existing.id}). Use --tenant to add a branch.`);
          [{ id: tenant }] = await tx`INSERT INTO tenants(name) VALUES (${shop}) RETURNING id`;
        }
        const branch = name(args[0] === '--tenant' ? args[2] : args[1], 'branch name');
        const [row] = await tx`INSERT INTO branches(tenant_id, name) VALUES (${tenant}, ${branch}) RETURNING id`;
        return { tenant, branch: row.id as string };
      });
      ({ tenant: tenantId, branch: branchId } = created);
    }
    const [names] = await sql`
      SELECT t.name AS shop, b.name AS branch FROM branches b JOIN tenants t ON t.id = b.tenant_id
      WHERE b.tenant_id = ${tenantId} AND b.id = ${branchId}`;
    const { code } = await createPairingCode(sql, { tenantId, branchId, label: `${names.branch} POS` });
    console.log(`Shop:    ${names.shop}\nBranch:  ${names.branch}\nTenant:  ${tenantId}\nBranchID ${branchId}`);
    console.log(`\nPairing code: ${code}  (one use, expires in ${PAIRING_TTL_MINUTES} minutes)`);
    console.log('Enter it in FloCafe: Settings > Cloud QR Ordering > Pairing code.');
  }
} finally {
  await sql.end();
}
