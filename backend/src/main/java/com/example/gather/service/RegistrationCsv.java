package com.example.gather.service;

import com.example.gather.domain.RosterRow;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

/** A bounded export intended for people opening it in Excel, rather than importing raw database values. */
final class RegistrationCsv {
    private static final ZoneId BEIJING = ZoneId.of("Asia/Shanghai");
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private RegistrationCsv() {}

    static byte[] encode(List<RosterRow> rows) {
        var csv = new StringBuilder("\uFEFF");
        append(csv, "报名记录ID", "用户名", "昵称", "报名状态", "签到状态", "首次报名时间（北京时间）",
            "报名更新时间（北京时间）", "签到时间（北京时间）", "签到管理员ID", "签到管理员昵称");
        for (var row : rows) {
            append(csv, text(Long.toString(row.id())), text(row.username()), text(row.displayName()),
                switch (row.status()) { case "ACTIVE" -> "有效报名"; case "WAITING" -> "候补"; default -> "已取消"; },
                !row.status().equals("ACTIVE") ? "不适用" : row.checkedInAt() == null ? "未签到" : "已签到",
                time(row.createdAt()), time(row.updatedAt()), time(row.checkedInAt()),
                row.checkedInBy() == null ? "" : text(Long.toString(row.checkedInBy())), text(row.checkedInByDisplayName()));
        }
        return csv.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String time(LocalDateTime utc) {
        return utc == null ? "" : TIME.format(utc.atOffset(ZoneOffset.UTC).atZoneSameInstant(BEIJING));
    }

    // The Tab stays inside the quoted field, protecting formula prefixes and preserving numeric IDs as text.
    // All free text is protected, including full-width prefixes or embedded separators/quotes/newlines.
    private static String text(String value) { return value == null || value.isEmpty() ? "" : "\t" + value; }

    private static void append(StringBuilder csv, String... cells) {
        for (int i = 0; i < cells.length; i++) {
            if (i > 0) csv.append(',');
            csv.append('"').append(cells[i].replace("\"", "\"\"")).append('"');
        }
        csv.append("\r\n");
    }
}
