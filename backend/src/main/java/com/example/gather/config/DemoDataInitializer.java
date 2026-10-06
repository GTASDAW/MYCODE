package com.example.gather.config;

import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneOffset;

@Component
@ConditionalOnProperty(name = "app.demo-seed-enabled", havingValue = "true", matchIfMissing = true)
public class DemoDataInitializer implements ApplicationRunner {
    private final UserMapper users;
    private final ActivityMapper activities;
    private final PasswordEncoder encoder;
    private final Clock clock;
    private final String adminPassword;
    private final String userPassword;

    public DemoDataInitializer(UserMapper users, ActivityMapper activities, PasswordEncoder encoder, Clock clock,
                               @Value("${app.demo-admin-password}") String adminPassword,
                               @Value("${app.demo-user-password}") String userPassword) {
        this.users = users;
        this.activities = activities;
        this.encoder = encoder;
        this.clock = clock;
        this.adminPassword = adminPassword;
        this.userPassword = userPassword;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        // Insert only missing accounts: restarting must never reset credentials or live counters.
        if (users.findByUsername("admin") == null) users.insert("admin", encoder.encode(adminPassword), "活动组织者", "ADMIN");
        if (users.findByUsername("demo") == null) users.insert("demo", encoder.encode(userPassword), "体验用户", "USER");
        if (activities.count() != 0) return;
        long adminId = users.findByUsername("admin").id();
        LocalDateTime base = LocalDateTime.ofInstant(clock.instant(), ZoneOffset.UTC).withNano(0);
        activities.insert(new NewActivity("把想法做成产品：全栈项目工作坊", "从一个真实需求开始，拆解页面、接口与数据库。带上你的电脑，一起跑通第一个完整业务流程。", "杭州 · 创客空间 A 厅", base.plusDays(7), 30, adminId));
        activities.insert(new NewActivity("周末城市漫步与摄影", "沿着街巷寻找日常里的特别瞬间。无需专业相机，欢迎带着手机和好奇心参加，活动结束后一起交流作品。", "上海 · 徐汇滨江集合点", base.plusDays(10), 16, adminId));
        activities.insert(new NewActivity("技术交流夜：聊聊并发与数据库", "用最后一个活动名额的竞争场景，聊数据库事务、行锁与重复请求。欢迎分享你在项目中遇到的真实问题。", "线上 · 会议信息报名后公布", base.plusDays(14), 10, adminId));
    }
}
