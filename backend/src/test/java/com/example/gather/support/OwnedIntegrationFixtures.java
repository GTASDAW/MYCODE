package com.example.gather.support;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Locale;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/** Exact in-process fixture IDs only; all reference checks precede transactional deletion. */
public final class OwnedIntegrationFixtures {
    private OwnedIntegrationFixtures() {}

    public static void remove(JdbcTemplate jdbc, Collection<Long> activityIds, Collection<Long> userIds) {
        remove(jdbc, activityIds, userIds, List.of());
    }

    public record FavoriteKey(long userId, long activityId) {}

    public static void remove(JdbcTemplate jdbc, Collection<Long> activityIds, Collection<Long> userIds, Collection<FavoriteKey> favorites) {
        List<Long> activities = ids(activityIds);
        List<Long> users = ids(userIds);
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(Objects.requireNonNull(jdbc.getDataSource())));
        transaction.executeWithoutResult(status -> {
            if (!"activity_platform_test".equals(jdbc.queryForObject("SELECT DATABASE()", String.class))
                || !"15".equals(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", String.class))) {
                throw new IllegalStateException("Fixture cleanup requires the dedicated V15 test database");
            }
            jdbc.queryForList("SELECT id, credential_version, avatar_image, avatar_hash FROM users LIMIT 0");
            if (!Long.valueOf(2).equals(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.COLUMNS "
                + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND IS_NULLABLE='YES' "
                + "AND ((COLUMN_NAME='avatar_image' AND DATA_TYPE='mediumblob') OR (COLUMN_NAME='avatar_hash' "
                + "AND DATA_TYPE='char' AND CHARACTER_MAXIMUM_LENGTH=64 AND CHARACTER_SET_NAME='ascii'))", Long.class)))
                throw new IllegalStateException("Fixture cleanup requires the V13 avatar column types");
            if (!Long.valueOf(1).equals(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS "
                + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND CONSTRAINT_NAME='chk_user_avatar_pair' AND ENFORCED='YES'", Long.class)))
                throw new IllegalStateException("Fixture cleanup requires the enforced V13 avatar pair constraint");
            noReferences(jdbc, "SELECT COUNT(*) FROM users WHERE (avatar_image IS NULL) <> (avatar_hash IS NULL) "
                + "OR (avatar_image IS NOT NULL AND (NOT REGEXP_LIKE(avatar_hash, '^[0-9a-f]{64}$', 'c') "
                + "OR BINARY avatar_hash <> BINARY SHA2(avatar_image,256)))", List.of(), "Invalid existing avatar pairs or checksums");
            jdbc.queryForList("SELECT id, category, cover_hash, cover_image, ends_at, registration_deadline, location_longitude, location_latitude FROM activities LIMIT 0");
            verifyLocationPointSchema(jdbc);
            verifyRegistrationCheckInSchema(jdbc);
            jdbc.queryForList("SELECT id, user_id, activity_id, created_at FROM activity_favorites LIMIT 0");
            if (!activities.isEmpty()) {
                jdbc.queryForList("SELECT id FROM activities WHERE id IN (" + marks(activities) + ") FOR UPDATE", activities.toArray());
                noReferences(jdbc, "SELECT COUNT(*) FROM activity_audit_logs a JOIN registrations r ON r.id=a.registration_id "
                    + "WHERE a.activity_id IN (" + marks(activities) + ") AND a.activity_id<>r.activity_id", activities,
                    "An owned audit references a different activity's registration");
                noReferences(jdbc, "SELECT COUNT(*) FROM activity_audit_logs a JOIN registrations r ON r.id=a.registration_id "
                    + "WHERE r.activity_id IN (" + marks(activities) + ") AND a.activity_id NOT IN (" + marks(activities) + ")",
                    concat(activities, activities), "An external audit references an owned registration");
            }
            if (!users.isEmpty()) {
                noReferences(jdbc, "SELECT COUNT(*) FROM users WHERE id IN (" + marks(users) + ") AND username IN ('admin','demo')",
                    users, "Predefined accounts must never be deleted");
                jdbc.queryForList("SELECT id FROM users WHERE id IN (" + marks(users) + ") FOR UPDATE", users.toArray());
                String outside = activities.isEmpty() ? "1=1" : "activity_id NOT IN (" + marks(activities) + ")";
                noReferences(jdbc, "SELECT COUNT(*) FROM activity_audit_logs WHERE actor_user_id IN (" + marks(users) + ") AND " + outside,
                    concat(users, activities), "An owned user is an actor in an external audit");
                noReferences(jdbc, "SELECT COUNT(*) FROM notifications WHERE user_id IN (" + marks(users) + ") AND " + outside,
                    concat(users, activities), "An owned user has external notifications");
                noReferences(jdbc, "SELECT COUNT(*) FROM registrations WHERE (user_id IN (" + marks(users) + ") OR checked_in_by IN ("
                    + marks(users) + ")) AND " + outside, concat(users, users, activities),
                    "An owned user has external registration or check-in references");
                String outsideActivity = activities.isEmpty() ? "1=1" : "id NOT IN (" + marks(activities) + ")";
                noReferences(jdbc, "SELECT COUNT(*) FROM activities WHERE (created_by IN (" + marks(users) + ") OR cancelled_by IN ("
                    + marks(users) + ")) AND " + outsideActivity, concat(users, users, activities),
                    "An owned user has external activity references");
            }
            var conditions = new ArrayList<String>();
            var favoriteParameters = new ArrayList<Long>();
            if (!activities.isEmpty()) { conditions.add("activity_id IN (" + marks(activities) + ")"); favoriteParameters.addAll(activities); }
            if (!users.isEmpty()) { conditions.add("user_id IN (" + marks(users) + ")"); favoriteParameters.addAll(users); }
            if (favorites.stream().anyMatch(row -> row.userId() < 1 || !activities.contains(row.activityId())))
                throw new IllegalStateException("Favorite ownership must refer to an owned activity");
            if (!conditions.isEmpty()) {
                var rows = jdbc.query("SELECT user_id,activity_id FROM activity_favorites WHERE " + String.join(" OR ", conditions) + " FOR UPDATE",
                    (result, number) -> new FavoriteKey(result.getLong(1), result.getLong(2)), favoriteParameters.toArray());
                if (rows.stream().anyMatch(row -> !activities.contains(row.activityId()) || !favorites.contains(row)))
                    throw new IllegalStateException("Fixture cleanup refused: external or undeclared favorite reference");
                for (var row : rows) jdbc.update("DELETE FROM activity_favorites WHERE user_id=? AND activity_id=?", row.userId(), row.activityId());
            }
            if (!activities.isEmpty()) {
                for (String table : List.of("activity_audit_logs", "notifications", "registrations")) {
                    jdbc.update("DELETE FROM " + table + " WHERE activity_id IN (" + marks(activities) + ")", activities.toArray());
                }
                jdbc.update("DELETE FROM activities WHERE id IN (" + marks(activities) + ")", activities.toArray());
            }
            if (!users.isEmpty()) jdbc.update("DELETE FROM users WHERE id IN (" + marks(users) + ")", users.toArray());
        });
    }

    public static void verifyLocationPointSchema(JdbcTemplate jdbc) {
        if (!Long.valueOf(2).equals(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.COLUMNS "
            + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='activities' AND IS_NULLABLE='YES' AND DATA_TYPE='decimal' AND NUMERIC_SCALE=7 "
            + "AND ((COLUMN_NAME='location_longitude' AND NUMERIC_PRECISION=10 AND COLUMN_TYPE='decimal(10,7)') "
            + "OR (COLUMN_NAME='location_latitude' AND NUMERIC_PRECISION=9 AND COLUMN_TYPE='decimal(9,7)'))", Long.class)))
            throw new IllegalStateException("Fixture cleanup requires the V14 nullable location decimal column types");
        var checks = jdbc.queryForList("SELECT c.CHECK_CLAUSE AS clause, t.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS t "
            + "JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME "
            + "WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='activities' AND t.CONSTRAINT_TYPE='CHECK' AND t.CONSTRAINT_NAME='chk_activity_location_point'");
        String expected = "((location_longitude IS NULL AND location_latitude IS NULL) OR (location_longitude IS NOT NULL AND location_latitude IS NOT NULL "
            + "AND location_longitude BETWEEN -180 AND 180 AND location_latitude BETWEEN -90 AND 90)) IS TRUE";
        if (checks.size() != 1 || !"YES".equals(checks.getFirst().get("enforced"))
            || !Objects.equals(LocationCheck.parse(expected), LocationCheck.parse(String.valueOf(checks.getFirst().get("clause")))))
            throw new IllegalStateException("Fixture cleanup requires the enforced V14 location pair/range constraint with IS TRUE");
        noReferences(jdbc, "SELECT COUNT(*) FROM activities WHERE (location_longitude IS NULL) <> (location_latitude IS NULL) "
            + "OR (location_longitude IS NOT NULL AND (location_longitude NOT BETWEEN -180 AND 180 OR location_latitude NOT BETWEEN -90 AND 90))",
            List.of(), "Invalid existing location point pairs or ranges");
    }

    public static void verifyRegistrationCheckInSchema(JdbcTemplate jdbc) {
        if (!Long.valueOf(4).equals(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registrations' AND ("
            + "(COLUMN_NAME='checked_in_at' AND DATA_TYPE='datetime' AND COLUMN_TYPE='datetime(6)' AND DATETIME_PRECISION=6 AND IS_NULLABLE='YES') OR "
            + "(COLUMN_NAME='checked_in_by' AND DATA_TYPE='bigint' AND COLUMN_TYPE='bigint' AND IS_NULLABLE='YES') OR "
            + "(COLUMN_NAME='check_in_method' AND DATA_TYPE='varchar' AND COLUMN_TYPE='varchar(16)' AND CHARACTER_MAXIMUM_LENGTH=16 AND CHARACTER_SET_NAME='ascii' AND COLLATION_NAME='ascii_bin' AND IS_NULLABLE='YES' AND COLUMN_DEFAULT IS NULL) OR "
            + "(COLUMN_NAME='check_in_version' AND DATA_TYPE='bigint' AND COLUMN_TYPE='bigint' AND NUMERIC_PRECISION=19 AND NUMERIC_SCALE=0 AND IS_NULLABLE='NO' AND COLUMN_DEFAULT='0'))", Long.class)))
            throw new IllegalStateException("Fixture cleanup requires the precise V15 check-in fields");
        String state = "((checked_in_at IS NULL AND checked_in_by IS NULL AND check_in_method IS NULL) OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='ADMIN' AND checked_in_by IS NOT NULL) OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='SELF_LOCATION' AND checked_in_by IS NULL)) IS TRUE";
        String actions = "action IN ('CREATE','EDIT','CANCEL','CHECK_IN','CHECK_IN_REVOKE')";
        String targets = "((action IN ('CHECK_IN','CHECK_IN_REVOKE') AND registration_id IS NOT NULL AND target_username IS NOT NULL AND target_display_name IS NOT NULL) OR (action NOT IN ('CHECK_IN','CHECK_IN_REVOKE') AND registration_id IS NULL AND target_username IS NULL AND target_display_name IS NULL)) IS TRUE";
        for (var expected : List.of(new String[]{"registrations", "chk_registration_check_in", state},
            new String[]{"registrations", "chk_registration_check_in_version", "check_in_version >= 0"},
            new String[]{"activity_audit_logs", "chk_audit_action", actions}, new String[]{"activity_audit_logs", "chk_audit_target", targets})) {
            var checks = jdbc.queryForList("SELECT c.CHECK_CLAUSE AS clause, t.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS t "
                + "JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME "
                + "WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='CHECK' AND t.CONSTRAINT_NAME=?", expected[0], expected[1]);
            String parsed = CheckInCheck.parse(checks.size() == 1 ? String.valueOf(checks.getFirst().get("clause")) : "");
            if (checks.size() != 1 || !"YES".equals(checks.getFirst().get("enforced")) || parsed == null || !parsed.equals(CheckInCheck.parse(expected[2])))
                throw new IllegalStateException("Fixture cleanup requires the enforced V15 check-in and audit constraints");
        }
        noReferences(jdbc, "SELECT COUNT(*) FROM registrations WHERE check_in_version IS NULL OR check_in_version < 0 OR NOT (" + state + ")", List.of(), "Invalid check-in method pairs or versions");
        noReferences(jdbc, "SELECT COUNT(*) FROM activity_audit_logs WHERE NOT ((" + actions + ") IS TRUE) OR NOT (" + targets + ")", List.of(), "Invalid audit actions or target pairs");
    }

    private static final class CheckInCheck {
        private final List<String> tokens;
        private int position;
        private CheckInCheck(String clause) {
            tokens = Pattern.compile("(?:_[a-z0-9]+)?'[^']*'|[a-z_][a-z_0-9]*|\\d+|>=|[(),=]|\\S", Pattern.CASE_INSENSITIVE)
                .matcher(clause.replaceAll("\\\\'([^'\\\\]*)\\\\'", "'$1'").replace("`", "")).results().map(match -> match.group()).toList();
        }
        static String parse(String clause) {
            try { var parser = new CheckInCheck(clause); String value = parser.expression(); return parser.position == parser.tokens.size() ? value : null; }
            catch (IllegalArgumentException | IndexOutOfBoundsException error) { return null; }
        }
        private boolean next(String token) { return position < tokens.size() && token.equalsIgnoreCase(tokens.get(position)); }
        private void take(String token) { if (!next(token)) throw new IllegalArgumentException(); position++; }
        private String expression() { return combine("or", () -> combine("and", this::atom)); }
        private String combine(String operator, Supplier<String> parse) {
            var values = new ArrayList<String>(); values.add(parse.get());
            while (next(operator)) { position++; values.add(parse.get()); }
            if (values.size() == 1) return values.getFirst();
            String prefix = operator + "[";
            return prefix + String.join(",", values.stream().map(value -> value.startsWith(prefix) ? value.substring(prefix.length(), value.length() - 1) : value).toList()) + "]";
        }
        private String value() {
            if (next("(")) { position++; String value = expression(); take(")"); return value; }
            String token = tokens.get(position++);
            if (token.matches("(?i)(?:_[a-z0-9]+)?'[^']*'")) return "literal[" + token.substring(token.indexOf("'")) + "]";
            if (!token.matches("[a-zA-Z_][a-zA-Z_0-9]*|\\d+")) throw new IllegalArgumentException();
            return token.toLowerCase(Locale.ROOT);
        }
        private String atom() {
            String value = value();
            if (next("=") || next(">=")) { String operator = tokens.get(position++); value = operator + "[" + value + "," + value() + "]"; }
            else if (next("in") || next("not")) {
                boolean negative = next("not"); if (negative) position++; take("in"); take("(");
                var choices = new ArrayList<String>(); choices.add(value());
                while (next(",")) { position++; choices.add(value()); } take(")");
                value = (negative ? "notin[" : "in[") + value + "," + String.join(",", choices) + "]";
            }
            if (next("is")) {
                position++; boolean negative = next("not"); if (negative) position++;
                if (next("null")) { position++; value = (negative ? "notnull[" : "null[") + value + "]"; }
                else { if (negative) throw new IllegalArgumentException(); take("true"); value = "true[" + value + "]"; }
            }
            return value;
        }
    }

    /** Preserve boolean grouping; dropping every parenthesis could accept a weakened CHECK. */
    private static final class LocationCheck {
        private final List<String> tokens;
        private int position;
        private LocationCheck(String clause) {
            tokens = Pattern.compile("[a-z_][a-z_0-9]*|\\d+(?:\\.\\d+)?|[()+-]|\\S")
                .matcher(clause.replace("`", "").toLowerCase(Locale.ROOT)).results().map(match -> match.group()).toList();
        }
        static String parse(String clause) {
            try { var parser = new LocationCheck(clause); String value = parser.expression(); return parser.position == parser.tokens.size() ? value : null; }
            catch (IllegalArgumentException | IndexOutOfBoundsException error) { return null; }
        }
        private boolean next(String token) { return position < tokens.size() && token.equals(tokens.get(position)); }
        private void take(String token) { if (!next(token)) throw new IllegalArgumentException(); position++; }
        private String expression() { return combine("or", () -> combine("and", this::atom)); }
        private String combine(String operator, Supplier<String> parse) {
            var values = new ArrayList<String>(); values.add(parse.get());
            while (next(operator)) { position++; values.add(parse.get()); }
            if (values.size() == 1) return values.getFirst();
            String prefix = operator + "[";
            return prefix + String.join(",", values.stream().map(value -> value.startsWith(prefix) ? value.substring(prefix.length(), value.length() - 1) : value).toList()) + "]";
        }
        private String atom() {
            String value;
            if (next("(")) { position++; value = expression(); take(")"); }
            else {
                String column = tokens.get(position++);
                if (!List.of("location_longitude", "location_latitude").contains(column)) throw new IllegalArgumentException();
                if (next("between")) { position++; String minimum = bound(); take("and"); value = "between[" + column + "," + minimum + "," + bound() + "]"; }
                else { take("is"); boolean absent = !next("not"); if (!absent) position++; take("null"); value = (absent ? "null[" : "notnull[") + column + "]"; }
            }
            if (next("is")) { position++; take("true"); value = "true[" + value + "]"; }
            return value;
        }
        private String bound() {
            int sign = 1;
            if (next("-")) { sign = -1; position++; } else if (next("+")) position++;
            java.math.BigDecimal value;
            if (next("(")) { position++; value = new java.math.BigDecimal(bound()); take(")"); }
            else { String token = tokens.get(position++); if (!token.matches("\\d+(?:\\.\\d+)?")) throw new IllegalArgumentException(); value = new java.math.BigDecimal(token); }
            return value.multiply(java.math.BigDecimal.valueOf(sign)).stripTrailingZeros().toPlainString();
        }
    }

    private static void noReferences(JdbcTemplate jdbc, String sql, List<Long> parameters, String reason) {
        if (!Long.valueOf(0).equals(jdbc.queryForObject(sql, Long.class, parameters.toArray())))
            throw new IllegalStateException("Fixture cleanup refused: " + reason);
    }

    private static List<Long> ids(Collection<Long> values) {
        var unique = new LinkedHashSet<>(values);
        if (unique.stream().anyMatch(value -> value == null || value < 1)) throw new IllegalArgumentException("Invalid owned fixture ID");
        return List.copyOf(unique);
    }

    private static String marks(List<Long> values) { return String.join(",", java.util.Collections.nCopies(values.size(), "?")); }

    @SafeVarargs
    private static List<Long> concat(List<Long>... lists) {
        var values = new ArrayList<Long>();
        for (var list : lists) values.addAll(list);
        return values;
    }
}
