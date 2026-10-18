package com.example.gather.support;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;

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
                || !"11".equals(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", String.class))) {
                throw new IllegalStateException("Fixture cleanup requires the dedicated V11 test database");
            }
            jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
            jdbc.queryForList("SELECT id, category, cover_hash, cover_image, ends_at FROM activities LIMIT 0");
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
