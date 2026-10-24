import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyLocationPointSchema } from './location-point-schema.mjs';

const clause = '((location_longitude IS NULL AND location_latitude IS NULL) OR (location_longitude IS NOT NULL AND location_latitude IS NOT NULL AND location_longitude BETWEEN -180 AND 180 AND location_latitude BETWEEN -90 AND 90)) IS TRUE';
function database({ mutate = () => {}, invalid = 0, queryOnly = false } = {}) {
  const columns = [{ name: 'location_latitude', type: 'decimal', columnType: 'decimal(9,7)', nullable: 'YES', numericPrecision: 9, numericScale: 7 },
    { name: 'location_longitude', type: 'decimal', columnType: 'decimal(10,7)', nullable: 'YES', numericPrecision: 10, numericScale: 7 }];
  const constraints = [{ clause, enforced: 'YES' }];
  mutate(columns, constraints);
  const calls = [];
  const read = async sql => { calls.push(sql); return [sql.includes('information_schema.COLUMNS') ? columns
    : sql.includes('information_schema.TABLE_CONSTRAINTS') ? constraints : [{ invalid }]]; };
  return { calls, [queryOnly ? 'query' : 'execute']: read };
}

test('V14 location gate validates exact nullable decimal types, enforced pair/range semantics and data without writes', async () => {
  for (const queryOnly of [false, true]) {
    const db = database({ queryOnly }); await verifyLocationPointSchema(db);
    assert.equal(db.calls.length, 3);
    assert.ok(db.calls.every(sql => sql.startsWith('SELECT ')));
    assert.match(db.calls[0], /NUMERIC_PRECISION AS numericPrecision, NUMERIC_SCALE AS numericScale/);
    assert.doesNotMatch(db.calls[0], /\bAS\s+(?:precision|scale)\b/i);
    assert.match(db.calls[2], /location_longitude IS NULL\) <> \(location_latitude IS NULL/);
    assert.match(db.calls[2], /NOT BETWEEN -180 AND 180/);
    assert.match(db.calls[2], /NOT BETWEEN -90 AND 90/);
  }
});

test('V14 location gate accepts MySQL redundant parentheses, decimal bounds and unary negative bounds', async () => {
  const db = database({ mutate: (_, constraints) => { constraints[0].clause = '((((`location_longitude` is null) and (`location_latitude` is null)) or ((`location_longitude` is not null) and (`location_latitude` is not null) and (`location_longitude` between -(180.0000000) and 180.0000000) and (`location_latitude` between -(90) and 90))) is true)'; } });
  await verifyLocationPointSchema(db);
});

test('V14 location gate rejects missing, non-nullable, approximate or differently scaled columns before content reads', async () => {
  for (const mutate of [columns => columns.pop(), columns => { columns[0].nullable = 'NO'; },
    columns => { columns[1].type = 'double'; }, columns => { columns[0].numericPrecision = 10; },
    columns => { columns[1].numericScale = 6; }, columns => { columns[0].columnType = 'decimal(9,7) unsigned'; }]) {
    const db = database({ mutate }); await assert.rejects(verifyLocationPointSchema(db), /V14/);
    assert.equal(db.calls.length, 1);
  }
});

test('V14 location gate rejects absent, unenforced and weakened constraints including changed boolean grouping', async () => {
  for (const mutate of [(_, constraints) => constraints.pop(), (_, constraints) => { constraints[0].enforced = 'NO'; },
    (_, constraints) => { constraints[0].clause = clause.replace(' IS TRUE', ''); },
    (_, constraints) => { constraints[0].clause = clause.replace('-180 AND 180', '-181 AND 180'); },
    (_, constraints) => { constraints[0].clause = clause.replace('-180 AND 180', '-180 AND 180.000000000000000001'); },
    (_, constraints) => { constraints[0].clause = clause.replace('location_latitude IS NOT NULL AND ', ''); },
    (_, constraints) => { constraints[0].clause = '((location_longitude IS NULL AND location_latitude IS NULL OR location_longitude IS NOT NULL AND location_latitude IS NOT NULL AND location_longitude BETWEEN -180 AND 180) AND location_latitude BETWEEN -90 AND 90) IS TRUE'; },
    (_, constraints) => { constraints[0].clause = 'location_longitude IS NULL OR location_latitude IS NULL'; }]) {
    const db = database({ mutate }); await assert.rejects(verifyLocationPointSchema(db), /constraint/);
    assert.equal(db.calls.length, 2);
  }
});

test('V14 location gate refuses unmatched and out-of-range existing points', async () => {
  await assert.rejects(verifyLocationPointSchema(database({ invalid: 1 })), /pairs or ranges are invalid/);
});
