// Read-only V14 gate shared by current-schema tools; historical V2 tools never call it.
function constraintExpression(clause) {
  const input = String(clause).replace(/`/g, '').toLowerCase();
  const tokens = input.match(/[a-z_][a-z_0-9]*|\d+(?:\.\d+)?|[()+-]|\S/g) ?? [];
  let position = 0;
  const take = expected => {
    if (tokens[position++] !== expected) throw new Error('Unexpected location constraint.');
  };
  const bound = () => {
    let negative = false;
    if (tokens[position] === '-') { negative = true; position++; }
    else if (tokens[position] === '+') position++;
    let value;
    if (tokens[position] === '(') { position++; value = bound(); take(')'); }
    else {
      const token = tokens[position++];
      if (!/^\d+(?:\.\d+)?$/.test(token ?? '')) throw new Error('Unexpected location bound.');
      value = token.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }
    return negative && value !== '0' ? value.startsWith('-') ? value.slice(1) : `-${value}` : value;
  };
  const atom = () => {
    let value;
    if (tokens[position] === '(') { position++; value = expression(); take(')'); }
    else {
      const column = tokens[position++];
      if (!['location_longitude', 'location_latitude'].includes(column)) throw new Error('Unexpected location column.');
      if (tokens[position] === 'between') {
        position++; const minimum = bound(); take('and'); value = ['between', column, minimum, bound()];
      } else {
        take('is'); const absent = tokens[position] !== 'not';
        if (!absent) position++;
        take('null'); value = [absent ? 'null' : 'notnull', column];
      }
    }
    if (tokens[position] === 'is') { position++; take('true'); value = ['true', value]; }
    return value;
  };
  const combine = (operator, parse) => {
    const values = [parse()];
    while (tokens[position] === operator) { position++; values.push(parse()); }
    return values.length === 1 ? values[0] : [operator, ...values.flatMap(value => value[0] === operator ? value.slice(1) : [value])];
  };
  const conjunction = () => combine('and', atom);
  const expression = () => combine('or', conjunction);
  try { const result = expression(); return position === tokens.length ? JSON.stringify(result) : null; }
  catch { return null; }
}

const locationConstraint = '((location_longitude IS NULL AND location_latitude IS NULL) OR (location_longitude IS NOT NULL AND location_latitude IS NOT NULL AND location_longitude BETWEEN -180 AND 180 AND location_latitude BETWEEN -90 AND 90)) IS TRUE';

export async function verifyLocationPointSchema(connection) {
  const read = (connection.execute ?? connection.query).bind(connection);
  const [columns] = await read("SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, NUMERIC_PRECISION AS numericPrecision, NUMERIC_SCALE AS numericScale FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='activities' AND COLUMN_NAME IN ('location_longitude','location_latitude') ORDER BY COLUMN_NAME");
  const longitude = columns.find(column => column.name === 'location_longitude');
  const latitude = columns.find(column => column.name === 'location_latitude');
  if (columns.length !== 2 || longitude?.type !== 'decimal' || longitude.columnType !== 'decimal(10,7)' || longitude.nullable !== 'YES'
      || Number(longitude.numericPrecision) !== 10 || Number(longitude.numericScale) !== 7
      || latitude?.type !== 'decimal' || latitude.columnType !== 'decimal(9,7)' || latitude.nullable !== 'YES'
      || Number(latitude.numericPrecision) !== 9 || Number(latitude.numericScale) !== 7) {
    throw new Error('The V14 nullable longitude DECIMAL(10,7)/latitude DECIMAL(9,7) schema is required.');
  }
  const [constraints] = await read("SELECT c.CHECK_CLAUSE AS clause, t.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='activities' AND t.CONSTRAINT_TYPE='CHECK' AND t.CONSTRAINT_NAME='chk_activity_location_point'");
  if (constraints.length !== 1 || constraints[0].enforced !== 'YES'
      || constraintExpression(constraints[0].clause) !== constraintExpression(locationConstraint)) {
    throw new Error('The enforced V14 location point pair/range constraint with IS TRUE is required.');
  }
  const [[invalid]] = await read('SELECT COUNT(*) AS invalid FROM activities WHERE (location_longitude IS NULL) <> (location_latitude IS NULL) OR (location_longitude IS NOT NULL AND (location_longitude NOT BETWEEN -180 AND 180 OR location_latitude NOT BETWEEN -90 AND 90))');
  if (!invalid || Number(invalid.invalid) !== 0) throw new Error('Existing location point pairs or ranges are invalid.');
}
