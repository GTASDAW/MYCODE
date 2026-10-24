import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyAvatarSchema } from './avatar-schema.mjs';

function database({ mutate = () => {}, invalid = 0 } = {}) {
  const columns = [{ name: 'avatar_hash', type: 'char', nullable: 'YES', charset: 'ascii', length: 64 },
    { name: 'avatar_image', type: 'mediumblob', nullable: 'YES', charset: null, length: 16777215 }];
  const constraints = [{ enforced: 'YES', clause: "((((`avatar_image` is null) and (`avatar_hash` is null)) or ((`avatar_image` is not null) and (`avatar_hash` is not null) and (octet_length(`avatar_image`) between 1 and 2097152) and regexp_like(`avatar_hash`,_ascii'^[0-9a-f]{64}$',_ascii'c'))) is true)" }];
  mutate(columns, constraints);
  const calls = [];
  return { calls, async execute(sql) {
    calls.push(sql);
    if (sql.includes('information_schema.COLUMNS')) return [columns];
    if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [constraints];
    return [[{ invalid }]];
  } };
}

test('V13 gate validates nullable binary/hash types, enforced pair constraint and full-byte SHA without writes', async () => {
  const db = database(); await verifyAvatarSchema(db);
  assert.equal(db.calls.length, 3);
  assert(db.calls.every(sql => sql.startsWith('SELECT ')));
  assert.match(db.calls[2], /BINARY SHA2\(avatar_image,256\)/);
  assert.match(db.calls[2], /REGEXP_LIKE\(avatar_hash, '\^\[0-9a-f\]\{64\}\$', 'c'\)/);
});

test('V13 gate refuses absent/wrong avatar fields and pair constraints before reading any avatar content', async () => {
  for (const mutate of [
    columns => columns.pop(), columns => { columns[0].type = 'varchar'; },
    columns => { columns[0].charset = 'utf8mb4'; }, columns => { columns[0].length = 63; },
    columns => { columns[1].type = 'blob'; }, columns => { columns[1].nullable = 'NO'; },
    (_, constraints) => constraints.pop(), (_, constraints) => { constraints[0].enforced = 'NO'; },
    (_, constraints) => { constraints[0].clause = 'avatar_hash is null or avatar_image is not null'; },
  ]) {
    const db = database({ mutate }); await assert.rejects(verifyAvatarSchema(db), /V13/);
    assert(!db.calls.some(sql => sql.includes('COUNT(*)')));
  }
});

test('V13 gate refuses unmatched or corrupted existing image/hash bytes', async () => {
  await assert.rejects(verifyAvatarSchema(database({ invalid: 1 })), /checksums are invalid/);
});

const mysql84Clause = "((((`avatar_image` is null) and (`avatar_hash` is null)) or ((`avatar_image` is not null) and (`avatar_hash` is not null) and (length(`avatar_image`) between 1 and 2097152) and regexp_like(`avatar_hash`,_utf8mb4\\'^[0-9a-f]{64}$\\',_utf8mb4\\'c\\'))) is true)";

test('V13 gate accepts the real MySQL 8.4 LENGTH clause with charset introducers and escaped quotes', async () => {
  for (const clause of [mysql84Clause, mysql84Clause.replaceAll("\\'", "'")]) {
    const db = database({ mutate: (_, constraints) => { constraints[0].clause = clause; } });
    await verifyAvatarSchema(db);
    assert.equal(db.calls.length, 3);
  }
});

test('constraint canonicalization preserves regex literal case, whitespace and matching flags', async () => {
  for (const clause of [
    mysql84Clause.replace('[0-9a-f]', '[0-9A-F]'),
    mysql84Clause.replace('[0-9a-f]', '[0-9a-f] '),
    mysql84Clause.replace("\\'c\\'", "\\'C\\'"),
    mysql84Clause.replace("\\'c\\'", "\\'c \\'"),
    mysql84Clause.replace('length(', 'char_length('),
    mysql84Clause.replace('2097152', '2097153'),
  ]) {
    const db = database({ mutate: (_, constraints) => { constraints[0].clause = clause; } });
    await assert.rejects(verifyAvatarSchema(db), /pair constraint/);
    assert(!db.calls.some(sql => sql.includes('COUNT(*)')));
  }
});
