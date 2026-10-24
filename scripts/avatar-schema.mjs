// Read-only V13 gate shared by current-schema tools; historical V2 tools never call it.
function canonicalConstraint(clause) {
  // MySQL reports OCTET_LENGTH as LENGTH and may escape quote delimiters.
  // Preserve string contents: changing regex case, spacing or flags changes the check.
  return String(clause).split(/((?:_[a-z0-9]+)?(?:\\'[^']*\\'|'[^']*'))/gi)
    .map((part, index) => index % 2
      ? part.replace(/^_[a-z0-9]+/i, '').replace(/^\\'|\\'$/g, "'")
      : part.toLowerCase().replace(/\blength\s*(?=\()/g, 'octet_length').replace(/[\s`()]/g, ''))
    .join('');
}

export async function verifyAvatarSchema(connection) {
  const read = (connection.execute ?? connection.query).bind(connection);
  const [columns] = await read("SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset, CHARACTER_MAXIMUM_LENGTH AS length FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME IN ('avatar_image','avatar_hash') ORDER BY COLUMN_NAME");
  const image = columns.find(column => column.name === 'avatar_image');
  const hash = columns.find(column => column.name === 'avatar_hash');
  if (columns.length !== 2 || image?.type !== 'mediumblob' || image.nullable !== 'YES'
      || hash?.type !== 'char' || hash.nullable !== 'YES' || hash.charset !== 'ascii' || Number(hash.length) !== 64) {
    throw new Error('The V13 nullable MEDIUMBLOB/avatar CHAR(64) ASCII schema is required.');
  }
  const [constraints] = await read("SELECT c.CHECK_CLAUSE AS clause, t.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='users' AND t.CONSTRAINT_TYPE='CHECK' AND t.CONSTRAINT_NAME='chk_user_avatar_pair'");
  const expected = "avatar_imageisnullandavatar_hashisnulloravatar_imageisnotnullandavatar_hashisnotnullandoctet_lengthavatar_imagebetween1and2097152andregexp_likeavatar_hash,'^[0-9a-f]{64}$','c'istrue";
  if (constraints.length !== 1 || constraints[0].enforced !== 'YES'
      || canonicalConstraint(constraints[0].clause) !== expected) {
    throw new Error('The enforced V13 avatar image/hash pair constraint is required.');
  }
  const [[invalid]] = await read("SELECT COUNT(*) AS invalid FROM users WHERE (avatar_image IS NULL) <> (avatar_hash IS NULL) OR (avatar_image IS NOT NULL AND (NOT REGEXP_LIKE(avatar_hash, '^[0-9a-f]{64}$', 'c') OR BINARY avatar_hash <> BINARY SHA2(avatar_image,256)))");
  if (!invalid || Number(invalid.invalid) !== 0) throw new Error('Existing avatar image/hash pairs or byte checksums are invalid.');
}
