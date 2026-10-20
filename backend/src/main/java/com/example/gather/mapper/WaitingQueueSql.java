package com.example.gather.mapper;

/** Read-only queue projections; aliases a and r are the activity and trusted caller's registration. */
final class WaitingQueueSql {
    private WaitingQueueSql() {}

    static final String COUNT = "(SELECT COUNT(*) FROM registrations rw WHERE rw.activity_id=a.id AND rw.status='WAITING') AS waiting_count, ";
    static final String POSITION = "CASE WHEN a.cancelled_at IS NULL AND r.status='WAITING' THEN 1 + "
        + "(SELECT COUNT(*) FROM registrations qp WHERE qp.activity_id=a.id AND qp.status='WAITING' "
        + "AND (r.updated_at > qp.updated_at OR (r.updated_at=qp.updated_at AND r.id > qp.id))) "
        + "ELSE NULL END AS waiting_position, ";
}
