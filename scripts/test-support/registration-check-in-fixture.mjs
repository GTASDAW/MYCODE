// Metadata contract substitute only; this helper never connects to MySQL.
export function checkInSchemaFixture() {
  return {
    columns: [
      { name: 'checked_in_at', type: 'datetime', columnType: 'datetime(6)', nullable: 'YES', datetimePrecision: 6 },
      { name: 'checked_in_by', type: 'bigint', columnType: 'bigint', nullable: 'YES' },
      { name: 'check_in_method', type: 'varchar', columnType: 'varchar(16)', nullable: 'YES', charset: 'ascii', collation: 'ascii_bin', length: 16, defaultValue: null },
      { name: 'check_in_version', type: 'bigint', columnType: 'bigint', nullable: 'NO', defaultValue: '0', numericPrecision: 19, numericScale: 0 },
    ],
    checks: [
      { tableName: 'registrations', name: 'chk_registration_check_in', enforced: 'YES', clause: "((checked_in_at IS NULL AND checked_in_by IS NULL AND check_in_method IS NULL) OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='ADMIN' AND checked_in_by IS NOT NULL) OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='SELF_LOCATION' AND checked_in_by IS NULL)) IS TRUE" },
      { tableName: 'registrations', name: 'chk_registration_check_in_version', enforced: 'YES', clause: 'check_in_version >= 0' },
      { tableName: 'activity_audit_logs', name: 'chk_audit_action', enforced: 'YES', clause: "action IN ('CREATE','EDIT','CANCEL','CHECK_IN','CHECK_IN_REVOKE')" },
      { tableName: 'activity_audit_logs', name: 'chk_audit_target', enforced: 'YES', clause: "((action IN ('CHECK_IN','CHECK_IN_REVOKE') AND registration_id IS NOT NULL AND target_username IS NOT NULL AND target_display_name IS NOT NULL) OR (action NOT IN ('CHECK_IN','CHECK_IN_REVOKE') AND registration_id IS NULL AND target_username IS NULL AND target_display_name IS NULL)) IS TRUE" },
    ], invalidRegistrations: 0, invalidAudits: 0,
  };
}

export function checkInSchemaRead(sql, fixture = checkInSchemaFixture()) {
  if (sql.includes('information_schema.COLUMNS') && sql.includes("TABLE_NAME='registrations'")) return [fixture.columns];
  if (sql.includes('information_schema.TABLE_CONSTRAINTS') && sql.includes('chk_registration_check_in_version')) return [fixture.checks];
  if (sql.startsWith('SELECT COUNT(*) AS invalid FROM registrations')) return [[{ invalid: fixture.invalidRegistrations }]];
  if (sql.startsWith('SELECT COUNT(*) AS invalid FROM activity_audit_logs')) return [[{ invalid: fixture.invalidAudits }]];
  return undefined;
}
