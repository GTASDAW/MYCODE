# 活动编辑与取消

管理员可以在活动开始前修改标题、介绍、地点和分类，或填写原因取消整场活动。取消会关闭报名，把有效报名和候补转为历史记录，并保留活动、报名 ID、首次取消原因和时间。用户在公开详情和“我的报名”中可以查看原因；后台列表、报名名单和概览同步使用数据库状态。

活动创建即发布，没有草稿或再次发布阶段；总名额及开始、结束时间创建后固定。已取消活动不能恢复，当前不提供活动删除。首次取消会向当时的有效报名及候补者写入站内通知，重复取消不重复通知。网站继续只在本机和临时 CI 环境运行。

## 结束时间与展示状态

创建接口接受可选的 UTC Instant 字段 endsAt，缺失或 null 均不提供结束时间。开始、结束先截断到微秒，非空结束必须严格晚于开始，否则返回 400；V11 新增可空 DATETIME(6) 与同样的数据库 CHECK。旧活动不回填，开始、结束与名额创建后固定。

所有活动响应（包括旧数组、分页、详情、管理名单、本人报名及收藏中的活动）增加 endsAt，其余字段保持兼容。closed 继续表示报名/用户取消已关闭，不表示活动已经结束；STARTED 筛选仍包含所有未取消且已开始的活动，既有统计口径不变。

| 时间条件（取消优先） | 页面状态 |
| --- | --- |
| 已取消 | 已取消 |
| 当前时刻早于开始 | 未开始 |
| 开始 ≤ 当前时刻 < 非空结束 | 进行中 |
| 当前时刻 ≥ 非空结束 | 已结束 |
| 已开始且结束为空 | 已开始；结束时间显示“未提供” |

接口与存储使用 UTC，表单和页面使用北京时间，表单不随浏览器所在时区改变解释。页面用一个可清理的时间边界计时器更新状态，不轮询接口；本地时间决定展示，写入权限仍由服务端核时。签到只检查已经开始、未取消及 ACTIVE 报名，结束后仍允许管理员补录。

字段路径：CreateActivityPage / beijingInputToIso → api.createActivity → CreateActivityRequest.endsAt → ActivityService.create → NewActivity / ActivityMapper.insert → V11 ends_at → ActivityRow / ActivityView → activityPhase / 页面；日历沿 CalendarDownloadButton 的最新详情读取到 buildActivityCalendar。创建审计由 AuditLogService.created 同事务保存。

日历有结束时输出 UTC DTEND，没有结束时不输出 DTEND 或 DURATION。日历为秒精度：合法的微秒起止若截断后落在同一秒，下载明确报错，不生成结束等于开始的无效事件。详见 [架构](architecture.md#活动日历导出)。

## 接口与输入

| 方法和路径 | 输入 | 成功结果与权限 |
| --- | --- | --- |
| `PATCH /api/admin/activities/{id}` | `{title,description,location,category?}` | 200，完整 `ActivityView`；ADMIN 且 CSRF 有效 |
| `POST /api/admin/activities/{id}/cancel` | `{reason}` | 200，完整 `ActivityView`；ADMIN 且 CSRF 有效 |

编辑字段去除首尾空白后不能为空，标题最多 100、介绍最多 10000、地点最多 200 个 Java 字符。取消原因去除首尾空白后为 1–500 个 Java 字符，原始输入不得包含 C0/C1 控制字符、换行、制表符或 Unicode 行/段分隔符 U+2028/U+2029。无效参数返回 400 `VALIDATION_ERROR`。

上段文本规则用于标题、介绍和地点。V8 的分类使用五种精确代码，单独变化也更新并追加 `EDIT`，省略或 `null` 则保留旧值，重复保存不追加；热锁投影、开始时间和名额规则不变。创建默认值、分类过滤和审计前后值见 [活动分类指南](activity-category-guide.md)。

Controller 的 `@Size` 也对原始字符串检查同一长度上限；不能发送超过上限的空白后指望服务层去除再接受。前端提交会先去除首尾空白，后端仍独立校验。

客户端只能提交上述业务字段。额外的 `capacity`、`startsAt`、`endsAt`、`cancelledBy` 或用户身份字段不会写入；实际操作人来自 Spring Security 的可信身份，角色由 `/api/admin/**` 权限规则检查。未登录返回 401，普通用户在真实有效 CSRF 下仍返回 403 `FORBIDDEN`，无效 CSRF 返回 403 `CSRF_INVALID`。不存在的活动返回 404 `ACTIVITY_NOT_FOUND`。

新增响应字段为：

| 字段 | 含义 |
| --- | --- |
| `cancelled` | `cancelled_at` 非空时为 `true` |
| `cancellationReason` | 首次成功取消的原因；未取消为 `null` |
| `cancelledAt` | UTC 的首次取消时间；未取消为 `null` |
| `closed` | 已取消，或开始时间不晚于本次服务端当前时间 |

这些字段出现在公开列表、详情、个人报名中的活动及管理查询中。`cancelled_by` 只作为数据库中的可信管理员审计关联，不由客户端决定。页面按北京时间显示时间。

## 状态和幂等

| 当前活动 | 编辑 | 组织者取消 | 用户报名或取消报名/候补 |
| --- | --- | --- | --- |
| 未开始且未取消 | 只改标题、介绍、地点和分类 | 关闭活动和报名，保存首次取消信息 | 沿用名额、幂等及候补 FIFO 规则 |
| 已开始且未取消 | 409 `ACTIVITY_CLOSED` | 409 `ACTIVITY_CLOSED` | 409 `ACTIVITY_CLOSED` |
| 已取消 | 409 `ACTIVITY_CANCELLED` | 有效请求重复返回首次结果 | 409 `ACTIVITY_CANCELLED` |

首次成功取消后，即使已越过原开始时间，再次取消仍保留原原因、时间、操作人和报名历史。请求仍须通过权限、CSRF 和原因校验；幂等不绕过这些校验。已取消状态的判断优先于已开始状态，因此历史页面不会在原开始时间到达后改显示成“已开始”。

活动取消时只更新 `ACTIVE` 和 `WAITING` 报名：两者均变为 `CANCELLED`，更新时间设为本次取消时间。此前已经是 `CANCELLED` 的记录保持原 ID、创建时间和更新时间不变。所有报名 ID 保留，没有候补递补，也没有删除用户的历史报名。

## 事务如何保护并发

编辑、组织者取消、用户报名和用户取消都使用 `READ_COMMITTED`，先通过 `ActivityMapper.lockById` 锁定同一个活动主键行，再判断是否已经取消或开始。开始时间检查发生在取得锁后，避免请求排队期间越过开始时间却仍成功操作。

一次组织者取消的事务按以下顺序执行：

1. 校验原因，从可信身份取得管理员 ID，锁活动行。
2. 已取消则返回首次结果；否则读取锁取得后的当前时间并检查尚未开始。
3. `RegistrationMapper.cancelForActivity` 把该活动的有效报名和候补统一置为 `CANCELLED`。
4. `ActivityMapper.cancel` 将人数置为 0，同时写入时间、原因和管理员 ID。
5. 在同一事务内读取完整详情，提交时一起持久化并释放锁。

用户报名先拿到锁时，可以完成报名，然后组织者取消该记录；组织者先拿到锁时，后续用户请求读到取消状态并返回 409。两种顺序都必须得到人数为 0、没有有效报名或候补的最终活动。用户取消和活动编辑也遵循同一行锁顺序，不依赖请求落到同一个 Java 实例。

中途异常会回滚报名状态、人数和取消元数据。数据库 CHECK 约束保证取消时间、原因和操作人同时为空或同时存在，且取消状态的人数必须为 0；它不能跨表保证没有 `ACTIVE` 或 `WAITING` 记录，这项不变量仍由事务和真实 MySQL 测试验证。报名唯一约束及候补索引保留。

## Flyway 与查询口径

新增迁移 `backend/src/main/resources/db/migration/V3__add_activity_cancellation.sql`，为 `activities` 增加：

- `cancelled_at DATETIME(6) NULL`，保存 UTC 微秒时间。
- `cancellation_reason VARCHAR(500) NULL`，保存取消原因。
- `cancelled_by BIGINT NULL`，通过外键关联管理员用户。
- `chk_activity_cancellation`，检查元数据完整性及取消人数为 0。

已有活动的三个新字段为 `NULL`，继续使用原来的报名规则；V1/V2 不改写，不删除或重建已有数据。确认是本项目开发/测试环境后，正常启动由 Flyway 执行增量迁移。

内部锁定投影现在包含开始时间、总名额、有效人数和 `cancelled_at` 四列，以支持新的业务判断。公开详情仍读取展示字段和真实候补人数；这与旧 V2 三列优化实验是不同的版本合同，见 [历史查询优化复盘](query-optimization-review.md)。

管理活动筛选新增 `CANCELLED`；`ALL` 包含全部活动，`UPCOMING`、`OPEN`、`FULL`、`STARTED` 都排除已取消活动。概览新增 `cancelledActivities`，`totalActivities` 继续含取消活动，其他活动时间状态和可报名名额排除取消活动。`activeRegistrations` 和 `waitingRegistrations` 仍直接统计报名表对应状态；取消事务完成后，该活动不贡献这两个值。统计和页面的详细合同见 [架构说明](architecture.md#管理查询与统计口径)。

## 页面与请求生命周期

活动管理表格和管理员详情在未开始、未取消时提供“编辑活动”“取消活动”。编辑路径为 `/admin/activities/{id}/edit`，时间和名额只读；取消弹窗需要填写原因，并说明有效报名与候补都会取消。失败时保留输入，可重新提交；成功后使用真实接口结果更新详情或重新读取列表。

普通用户访问编辑路由时，管理员保护组件在挂载页面前拒绝访问，避免发起活动编辑数据请求。直接刷新编辑路径、页面加载、错误重试和手机表单均使用现有路由与布局。

`useActivityMutation` 持有页面自己的提交和 AbortController，离开页面取消请求，成功和失败响应都检查页面是否仍挂载及 AuthProvider 的认证代次。退出后重新登录、切换账号或导航到其他活动时，旧响应不能更新页面、触发旧导航或因迟到 401 使新会话退出。成功数据来自实际接口，界面不推测活动已经取消。

中断客户端等待不表示已经提交的服务端写入会回滚。响应丢失或迟到后再次打开活动，应从接口读取真实结果；编辑迟到回归同时检查原活动已保存和新页面未被旧导航覆盖。

详情、公开活动卡片及个人记录优先显示“活动已取消”。详情、个人历史和报名名单显示同一原因和北京时间；报名按钮关闭，名单保留 `CANCELLED` 报名行。各独立窗口下一次请求才读取最新状态，没有实时推送。

## 实际验证与阅读路径

2026-10-09 已完成真实 MySQL 后端 63 项测试、前端 25 项测试及生产构建、精确清理 24 项安全回归。最新远程 CI 五任务全部成功，默认与 Redis 模式各 40 项桌面/手机浏览器检查通过，Redis 14 项生命周期检查通过；源码、失败修复和清理证据见 [验证记录](verification.md)。

生命周期后端用例包括：三个允许字段及不可变字段、ADMIN/CSRF、原因校验、保留历史与幂等、开始时间边界、取消筛选与统计、数据库约束、中途异常回滚；还在真实 MySQL 上控制两种行锁顺序，验证报名、用户取消、编辑与组织者取消的竞态。Redis 真实双实例验证了报名/取消竞争、历史保留与人数归零。

以上为原生命周期阶段的文本字段验证。V8 新增分类单独变化、缺失/null 保留、无变化与审计回滚的独立回归，编辑当前支持三个文本字段和一个分类字段；结果见验证记录的分类分节。

浏览器覆盖真实发布 → 编辑 → 新用户有效报名与另一用户候补 → 活动取消 → 详情、个人历史、名单和统计。失败与迟到响应场景只控制传输，恢复成功时仍调用实际 Java/MySQL。测试的活动和账号预先登记 manifest；编辑前额外登记精确允许的标题/介绍版本，所有版本保留本轮完整 UUID 标记。清理只接受这些版本和准确身份，响应丢失仍可恢复，未知修改或外部引用会拒绝清理。

推荐沿一次取消请求阅读：

1. `AdminController`、`SecurityConfiguration`：路径、可信管理员身份、权限与 CSRF。
2. `ActivityService.cancel`：隔离级别、活动行锁、幂等、开始时间检查和事务边界。
3. `ActivityMapper`、`RegistrationMapper`、V3：状态更新顺序、外键和 CHECK 能保证的范围。
4. `ApiModels.ActivityView`、`AdminMapper`：取消字段、`closed`、筛选和统计口径。
5. `EditActivityPage`、`ActivityManagementActions`、`useActivityMutation`、`AuthRequestGuard`：输入、失败重试、离页与账号切换保护。
6. `ActivityLifecycleIntegrationTest`、`e2e/lifecycle.spec.ts`、`scripts/redis-session-check.mjs`：真实锁顺序、回滚、页面流程和双实例证据。

并发场景示例：“用户报名与组织者取消可能同时到达，权限控制只能决定谁能操作；最终数据正确还需要两者锁同一活动行，并在同一事务中处理人数、状态和取消元数据。历史记录保留且重复取消稳定，方便用户和组织者解释发生了什么。”
