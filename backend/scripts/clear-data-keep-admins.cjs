// Preview by default. --execute permanently clears application data in one transaction.
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const execute = process.argv.includes('--execute');
const url = new URL(process.env.DATABASE_URL);
const schema = url.searchParams.get('schema') || 'public';
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const tableName = (name) => `${quote(schema)}.${quote(name)}`;
const expected = [...readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8').matchAll(/@@map\("([^\"]+)"\)/g)].map((match) => match[1]);
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

async function counts(tables) {
  const result = {};
  for (const table of tables) result[table] = Number((await client.query(`SELECT count(*) AS count FROM ${tableName(table)}`)).rows[0].count);
  return result;
}

async function main() {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '15s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY tablename", [schema])).rows.map((row) => row.tablename);
  const unknown = tables.filter((table) => !expected.includes(table));
  if (unknown.length || !tables.includes('users')) throw new Error('Unexpected application schema; deletion aborted.');
  if (execute) await client.query(`LOCK TABLE ${tables.map(tableName).join(', ')} IN ACCESS EXCLUSIVE MODE`);
  const admins = (await client.query(`SELECT id, email, password, role, "isActive", "deletedAt" FROM ${tableName('users')} WHERE role = 'ADMIN' ORDER BY id`)).rows;
  if (!admins.some((admin) => admin.isActive && !admin.deletedAt && admin.password)) throw new Error('No active admin account to preserve; deletion aborted.');
  const before = await counts(tables);
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', database: url.pathname.slice(1), schema, preservedAdminAccounts: admins.length, before }, null, 2));
  if (!execute) { await client.query('ROLLBACK'); return; }

  // Delete referencing tables first. Never disable constraints or cascade outside this schema.
  const dependencies = (await client.query(`SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = fk.confrelid
    WHERE fk.contype = 'f' AND ns.nspname = $1`, [schema])).rows;
  const remaining = new Set(tables.filter((table) => table !== 'users'));
  while (remaining.size) {
    const next = [...remaining].find((table) => !dependencies.some((fk) => fk.parent === table && fk.child !== table && remaining.has(fk.child)));
    if (!next) throw new Error('Cyclic table dependencies; deletion rolled back.');
    await client.query(`DELETE FROM ${tableName(next)}`);
    remaining.delete(next);
  }
  await client.query(`DELETE FROM ${tableName('users')} WHERE role <> 'ADMIN'`);
  await client.query(`UPDATE ${tableName('users')} SET
    "averageRating" = 0, "totalRatings" = 0, "totalDeliveries" = 0,
    "completedDeliveries" = 0, "cancelledDeliveries" = 0,
    "averageDeliveryTime" = NULL, "onTimeDeliveryRate" = 0, "totalEarnings" = 0,
    "totalParcelsEverSent" = 0, "totalParcelsReceived" = 0,
    "currentLat" = NULL, "currentLng" = NULL, "driverApprovedBy" = NULL
    WHERE role = 'ADMIN'`);
  const preserved = (await client.query(`SELECT id, email, password, role, "isActive", "deletedAt" FROM ${tableName('users')} ORDER BY id`)).rows;
  if (JSON.stringify(admins) !== JSON.stringify(preserved)) throw new Error('Admin credential preservation check failed; deletion rolled back.');
  const after = await counts(tables);
  if (Object.entries(after).some(([table, count]) => table === 'users' ? count !== admins.length : count !== 0)) throw new Error('Remaining data detected; deletion rolled back.');
  await client.query('COMMIT');
  console.log(JSON.stringify({ committed: true, adminCredentialsUnchanged: true, after }, null, 2));
}

main().catch(async (error) => {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Database cleanup failed:', error.code || error.message);
  process.exitCode = 1;
}).finally(() => client.end());
