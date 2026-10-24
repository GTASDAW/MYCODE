// Read-only V15 gate. Historical fixed-V2 tools must never call this module.
const pairedState = "((checked_in_at IS NULL AND checked_in_by IS NULL AND check_in_method IS NULL) OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='ADMIN' AND checked_in_by IS NOT NULL) OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='SELF_LOCATION' AND checked_in_by IS NULL)) IS TRUE";
const auditActions = "action IN ('CREATE','EDIT','CANCEL','CHECK_IN','CHECK_IN_REVOKE')";
const auditTarget = "((action IN ('CHECK_IN','CHECK_IN_REVOKE') AND registration_id IS NOT NULL AND target_username IS NOT NULL AND target_display_name IS NOT NULL) OR (action NOT IN ('CHECK_IN','CHECK_IN_REVOKE') AND registration_id IS NULL AND target_username IS NULL AND target_display_name IS NULL)) IS TRUE";

// Compare parsed expressions, preserving grouping, literal case and IS TRUE.
// MySQL may add parentheses, backticks and character-set introducers in metadata.
function expressionTree(clause) {
  // CHECK_CLAUSE on MySQL 8.4 also represents delimiters as _utf8mb4\'VALUE\'.
  // Only normalize a complete pair without an internal quote/backslash.
  const input = String(clause).replace(/\\'([^'\\]*)\\'/g, "'$1'").replace(/`/g, '');
  const tokens = input.match(/(?:_[a-z0-9]+)?'(?:''|\\.|[^'\\])*'|[a-z_][a-z_0-9]*|\d+|>=|<>|!=|[(),=+-]|\S/gi) ?? [];
  let position = 0;
  const peek = token => tokens[position]?.toLowerCase() === token;
  const take = token => { if (!peek(token)) throw new Error(); position++; };
  const value = () => {
    if (peek('(')) { position++; const result = expression(); take(')'); return result; }
    const token = tokens[position++];
    if (/^(?:_[a-z0-9]+)?'/i.test(token ?? '')) return ['literal', token.replace(/^_[a-z0-9]+/i, '').slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'")];
    if (/^\d+$/.test(token ?? '')) return ['number', BigInt(token).toString()];
    if (!/^[a-z_][a-z_0-9]*$/i.test(token ?? '')) throw new Error();
    return ['column', token.toLowerCase()];
  };
  const atom = () => {
    let result = value();
    if (peek('=') || peek('>=') || peek('<>') || peek('!=')) { const operator = tokens[position++]; result = [operator, result, value()]; }
    else if (peek('in') || peek('not')) {
      const negative = peek('not'); if (negative) position++; take('in'); take('(');
      const choices = [value()]; while (peek(',')) { position++; choices.push(value()); } take(')');
      result = [negative ? 'notin' : 'in', result, ...choices];
    }
    if (peek('is')) {
      position++; const negative = peek('not'); if (negative) position++;
      if (peek('null')) { position++; result = [negative ? 'notnull' : 'null', result]; }
      else { if (negative) throw new Error(); take('true'); result = ['true', result]; }
    }
    return result;
  };
  const combine = (operator, parse) => {
    const values = [parse()];
    while (peek(operator)) { position++; values.push(parse()); }
    return values.length === 1 ? values[0] : [operator, ...values.flatMap(item => item[0] === operator ? item.slice(1) : [item])];
  };
  const expression = () => combine('or', () => combine('and', atom));
  try { const tree = expression(); return position === tokens.length ? JSON.stringify(tree) : null; } catch { return null; }
}

export async function verifyRegistrationCheckInSchema(connection) {
  const read = (connection.execute ?? connection.query).bind(connection);
  const [columns] = await read("SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, CHARACTER_MAXIMUM_LENGTH AS length, DATETIME_PRECISION AS datetimePrecision, NUMERIC_PRECISION AS numericPrecision, NUMERIC_SCALE AS numericScale FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registrations' AND COLUMN_NAME IN ('checked_in_at','checked_in_by','check_in_method','check_in_version') ORDER BY COLUMN_NAME");
  const byName = Object.fromEntries(columns.map(column => [column.name, column]));
  const at = byName.checked_in_at, by = byName.checked_in_by, method = byName.check_in_method, version = byName.check_in_version;
  if (columns.length !== 4 || at?.type !== 'datetime' || at.columnType !== 'datetime(6)' || at.nullable !== 'YES' || Number(at.datetimePrecision) !== 6
      || by?.type !== 'bigint' || by.columnType !== 'bigint' || by.nullable !== 'YES'
      || method?.type !== 'varchar' || method.columnType !== 'varchar(16)' || method.nullable !== 'YES' || method.charset !== 'ascii' || method.collation !== 'ascii_bin' || Number(method.length) !== 16 || method.defaultValue !== null
      || version?.type !== 'bigint' || version.columnType !== 'bigint' || version.nullable !== 'NO' || String(version.defaultValue) !== '0' || Number(version.numericPrecision) !== 19 || Number(version.numericScale) !== 0) {
    throw new Error('The V15 nullable DATETIME(6)/administrator BIGINT, ASCII binary method and non-null BIGINT default-zero check-in version schema is required.');
  }
  const [checks] = await read("SELECT t.TABLE_NAME AS tableName, t.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS clause, t.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.CONSTRAINT_TYPE='CHECK' AND ((t.TABLE_NAME='registrations' AND t.CONSTRAINT_NAME IN ('chk_registration_check_in','chk_registration_check_in_version')) OR (t.TABLE_NAME='activity_audit_logs' AND t.CONSTRAINT_NAME IN ('chk_audit_action','chk_audit_target')))");
  for (const [tableName, name, clause] of [['registrations','chk_registration_check_in',pairedState],['registrations','chk_registration_check_in_version','check_in_version >= 0'],['activity_audit_logs','chk_audit_action',auditActions],['activity_audit_logs','chk_audit_target',auditTarget]]) {
    const rows = checks.filter(row => row.tableName === tableName && row.name === name);
    if (rows.length !== 1 || rows[0].enforced !== 'YES' || expressionTree(rows[0].clause) !== expressionTree(clause)) {
      throw new Error('The enforced V15 check-in method pairing/version and audit action/target constraints are required.');
    }
  }
  const [[registrations]] = await read(`SELECT COUNT(*) AS invalid FROM registrations WHERE check_in_version IS NULL OR check_in_version < 0 OR NOT (${pairedState})`);
  if (!registrations || Number(registrations.invalid) !== 0) throw new Error('Existing registration check-in method pairs or versions are invalid.');
  const [[audits]] = await read(`SELECT COUNT(*) AS invalid FROM activity_audit_logs WHERE NOT ((${auditActions}) IS TRUE) OR NOT (${auditTarget})`);
  if (!audits || Number(audits.invalid) !== 0) throw new Error('Existing check-in audit actions or targets are invalid.');
}
