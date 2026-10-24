import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyRegistrationCheckInSchema } from './registration-check-in-schema.mjs';
import { checkInSchemaFixture, checkInSchemaRead } from './test-support/registration-check-in-fixture.mjs';

function database(mutate = () => {}) {
  const fixture = checkInSchemaFixture(), queries = []; mutate(fixture);
  return { queries, async execute(sql) { queries.push(sql); const rows = checkInSchemaRead(sql, fixture); assert.ok(rows, 'Only the four scoped read-only schema/data reads are allowed'); return rows; } };
}

test('V15 check-in gate validates precise fields, four enforced checks and existing data using reads only', async () => {
  const db = database(); await verifyRegistrationCheckInSchema(db);
  assert.equal(db.queries.length, 4); assert.ok(db.queries.every(sql => sql.startsWith('SELECT ')));
  assert.ok(db.queries[2].includes('IS TRUE')); assert.ok(db.queries[3].includes('CHECK_IN_REVOKE'));
});

test('V15 metadata accepts MySQL redundant parentheses and character-set string introducers', async () => {
  const db = database(fixture => { fixture.checks = fixture.checks.map(row => ({ ...row, clause: row.clause.replace(/'([^']*)'/g, "_ascii'$1'").replace(/check_in_version >= 0/, '(`check_in_version` >= (0))') })); });
  await verifyRegistrationCheckInSchema(db);
});

test('V15 gate rejects missing or weakened types, precision, nullability, binary collation and default', async () => {
  const mutations = [f => f.columns.pop(), f => f.columns[0].datetimePrecision = 0, f => f.columns[0].columnType = 'datetime',
    f => f.columns[1].nullable = 'NO', f => f.columns[2].charset = 'utf8mb4', f => f.columns[2].collation = 'ascii_general_ci',
    f => f.columns[2].length = 15, f => f.columns[2].defaultValue = 'ADMIN', f => f.columns[3].nullable = 'YES',
    f => f.columns[3].columnType = 'bigint unsigned', f => f.columns[3].numericPrecision = 20, f => f.columns[3].defaultValue = '1'];
  for (const mutate of mutations) { const db = database(mutate); await assert.rejects(verifyRegistrationCheckInSchema(db), /V15/); assert.equal(db.queries.length, 1); }
});

test('V15 gate rejects absent, unenforced, regrouped, case-weakened and incomplete audit checks before data reads', async () => {
  const mutations = [f => f.checks.pop(), f => f.checks[0].enforced = 'NO', f => f.checks[0].clause = f.checks[0].clause.replace(/ IS TRUE$/, ''),
    f => f.checks[0].clause = f.checks[0].clause.replace("check_in_method='ADMIN' AND checked_in_by IS NOT NULL", "check_in_method='ADMIN' OR checked_in_by IS NOT NULL"),
    f => f.checks[0].clause = f.checks[0].clause.replace('SELF_LOCATION', 'self_location'), f => f.checks[1].clause = 'check_in_version >= -1',
    f => f.checks[2].clause = f.checks[2].clause.replace(",'CHECK_IN_REVOKE'", ''), f => f.checks[3].clause = f.checks[3].clause.replace(/ IS TRUE$/, ''),
    f => f.checks[3].clause = f.checks[3].clause.replace('registration_id IS NOT NULL', 'registration_id IS NULL')];
  for (const mutate of mutations) { const db = database(mutate); await assert.rejects(verifyRegistrationCheckInSchema(db), /V15/); assert.equal(db.queries.length, 2); }
});

test('V15 gate refuses invalid registration pairs/versions and audit targets in current rows', async () => {
  for (const column of ['invalidRegistrations', 'invalidAudits']) {
    const db = database(fixture => fixture[column] = 1); await assert.rejects(verifyRegistrationCheckInSchema(db), /Existing/);
  }
});

// Exact read-only information_schema output from MySQL 8.4.11 (no business rows).
const mysql8411Checks = [
  {
    "tableName": "activity_audit_logs",
    "name": "chk_audit_action",
    "clause": "(`action` in (_utf8mb4\\'CREATE\\',_utf8mb4\\'EDIT\\',_utf8mb4\\'CANCEL\\',_utf8mb4\\'CHECK_IN\\',_utf8mb4\\'CHECK_IN_REVOKE\\'))",
    "enforced": "YES"
  },
  {
    "tableName": "activity_audit_logs",
    "name": "chk_audit_target",
    "clause": "((((`action` in (_utf8mb4\\'CHECK_IN\\',_utf8mb4\\'CHECK_IN_REVOKE\\')) and (`registration_id` is not null) and (`target_username` is not null) and (`target_display_name` is not null)) or ((`action` not in (_utf8mb4\\'CHECK_IN\\',_utf8mb4\\'CHECK_IN_REVOKE\\')) and (`registration_id` is null) and (`target_username` is null) and (`target_display_name` is null))) is true)",
    "enforced": "YES"
  },
  {
    "tableName": "registrations",
    "name": "chk_registration_check_in",
    "clause": "((((`checked_in_at` is null) and (`checked_in_by` is null) and (`check_in_method` is null)) or ((`status` = _utf8mb4\\'ACTIVE\\') and (`checked_in_at` is not null) and (`check_in_method` = _utf8mb4\\'ADMIN\\') and (`checked_in_by` is not null)) or ((`status` = _utf8mb4\\'ACTIVE\\') and (`checked_in_at` is not null) and (`check_in_method` = _utf8mb4\\'SELF_LOCATION\\') and (`checked_in_by` is null))) is true)",
    "enforced": "YES"
  },
  {
    "tableName": "registrations",
    "name": "chk_registration_check_in_version",
    "clause": "(`check_in_version` >= 0)",
    "enforced": "YES"
  }
];

test('V15 gate accepts all four exact MySQL 8.4.11 escaped CHECK_CLAUSE definitions', async () => {
  const db = database(fixture => { fixture.checks = structuredClone(mysql8411Checks); });
  await verifyRegistrationCheckInSchema(db); assert.equal(db.queries.length, 4);
});

test('real MySQL escaped clauses still reject weakened grouping, literal case, version and audit pairing', async () => {
  const mutations = [checks => { const state = checks.find(row => row.name === 'chk_registration_check_in'); state.clause = state.clause.replace(' and (`checked_in_by` is not null)', ' or (`checked_in_by` is not null)'); },
    checks => { const state = checks.find(row => row.name === 'chk_registration_check_in'); state.clause = state.clause.replace('SELF_LOCATION', 'self_location'); },
    checks => { checks.find(row => row.name === 'chk_registration_check_in_version').clause = '(`check_in_version` >= -1)'; },
    checks => { const target = checks.find(row => row.name === 'chk_audit_target'); target.clause = target.clause.replace(' is true)', ')'); },
    checks => { const action = checks.find(row => row.name === 'chk_audit_action'); action.clause = action.clause.replace('CHECK_IN_REVOKE', 'EDIT'); }];
  for (const mutate of mutations) {
    const db = database(fixture => { fixture.checks = structuredClone(mysql8411Checks); mutate(fixture.checks); });
    await assert.rejects(verifyRegistrationCheckInSchema(db), /V15/); assert.equal(db.queries.length, 2);
  }
});
