# 源码阅读指南

本文按请求链路列出实现与验证入口。启动方式见 [README](../README.md)，实际运行结果及环境限制见 [验证记录](verification.md)。

## 请求链路

页面通过 [统一 HTTP 客户端](../frontend/src/api.ts) 调用后端；Spring Security 核对 Session、CSRF 和权限，Controller 校验入口，Service 管理业务与事务，Mapper 执行 SQL。用户身份来自可信 Session。

| 功能 | 源码入口 | 合同与验证入口 |
| --- | --- | --- |
| 活动查询 | ActivitiesPage → ActivityController → ActivityService → ActivityMapper / ActivityQuerySql | [活动发现](activity-discovery.md)、[分类](activity-category-guide.md) |
| 报名与候补 | ActivityDetailPage → RegistrationService → ActivityMapper / RegistrationMapper | [并发事务](concurrency-review.md)、[活动生命周期](activity-lifecycle.md) |
| 注册与资料 | RegisterPage / ProfilePage → AuthProvider → AuthController / ProfileController → AccountService | [账户](account-guide.md) |
| 改密与会话 | ProfilePage → PasswordChangeService → UserMapper；CredentialVersionFilter 在授权前读取版本 | [改密](password-change-guide.md)、[共享 Session](shared-session.md)、[限流](auth-rate-limit.md) |
| 本人报名 | MyRegistrationsPage → RegistrationService → RegistrationMapper | [分页、联表与快照](my-registrations-guide.md) |
| 通知 | NotificationProvider → NotificationService → NotificationMapper | [站内通知](notification-guide.md) |
| 签到与名单 | AdminRegistrationsPage → CheckInService / AdminService → AdminMapper | [签到与 CSV](checkin-export-guide.md)、[签到分析](attendance-guide.md) |
| 审计 | AdminAuditLogsPage → AuditLogService → AuditLogMapper | [操作记录](audit-log-guide.md) |
| 封面与日历 | ActivityCoverEditor → ActivityCoverService；CalendarDownloadButton → activityCalendar | [架构](architecture.md) |
| 备份恢复 | database-backup.mjs → backup-restore-drill.mjs | [交付与恢复边界](delivery-guide.md) |

## 验证入口

- 后端真实 MySQL 回归位于 backend/src/test/java；专用测试库为 activity_platform_test。
- 前端纯函数与请求保护回归位于 frontend/tests；真实桌面和手机流程位于 e2e。
- 增量结构以 backend/src/main/resources/db/migration 为准；既有迁移不改写。
- [SQL 复盘](query-optimization-review.md)和[前端加载](frontend-loading-guide.md)分别记录测量条件；不从查询次数或产物大小推断未测性能。
- [本地业务演示](demo-guide.md)提供操作步骤，不替代自动化测试或生产验收。
