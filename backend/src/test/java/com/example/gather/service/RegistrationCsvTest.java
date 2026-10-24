package com.example.gather.service;

import com.example.gather.domain.RosterRow;
import org.junit.jupiter.api.Test;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.List;
import static org.assertj.core.api.Assertions.*;

class RegistrationCsvTest {
    private static final LocalDateTime UTC = LocalDateTime.parse("2035-08-01T09:00:00.123456");

    @Test
    void protectsAllFormulaPrefixesSeparatorsQuotesAndEmbeddedLineBreaksWithoutChangingRows() {
        for (String value : List.of("=1+1", "+SUM(A1)", "-1", "@SUM(A1)", "＝1", "＋1", "－1", "＠1", "\t=1", "\r=1", "\n=1", "中文,\"名字\"\r\n下一行")) {
            var row = new RosterRow(Long.MAX_VALUE, 1, value, value, "ACTIVE", UTC, UTC, UTC, Long.MAX_VALUE, value);
            String csv = new String(RegistrationCsv.encode(List.of(row)), StandardCharsets.UTF_8);
            assertThat(csv).startsWith("\uFEFF\"报名记录ID\"").endsWith("\r\n");
            assertThat(csv).contains("\"\t" + value.replace("\"", "\"\"") + "\"");
            assertThat(csv).contains("\"\t9223372036854775807\"");
            assertThat(row.displayName()).isEqualTo(value);
        }
    }

    @Test
    void usesBeijingTimeAndAppendsMethodWithoutChangingExistingColumns() {
        var checked = new RosterRow(1, 10, "zhang", "张同学", "ACTIVE", UTC, UTC, UTC, 20L, "李管理员");
        var waiting = new RosterRow(2, 11, "wang", "王同学", "WAITING", UTC, UTC, null, null, null);
        var cancelled = new RosterRow(3, 12, "liu", "刘同学", "CANCELLED", UTC, UTC, null, null, null);
        String csv = new String(RegistrationCsv.encode(List.of(checked, waiting, cancelled)), StandardCharsets.UTF_8);
        assertThat(csv).contains("\"2035-08-01 17:00:00\"").doesNotContain("2035-08-01 09:00:00");
        assertThat(csv.split("\r\n")).hasSize(4);
        for (String line : csv.split("\r\n")) assertThat(line.split(",")).hasSize(11);
        assertThat(csv).contains("\"签到管理员昵称\",\"签到方式\"").contains("\"管理员签到\"");
        assertThat(csv).contains("\"有效报名\",\"已签到\"").contains("\"候补\",\"不适用\"").contains("\"已取消\",\"不适用\"");
        assertThat(csv).contains("\"\t张同学\"").contains("\"\t李管理员\"");
    }
}
