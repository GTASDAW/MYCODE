# 活动编辑与取消

管理员可以在活动开始前修改标题、介绍、地点和分类，或填写原因取消整场活动。取消会关闭报名，把有效报名和候补转为历史记录，并保留活动、报名 ID、首次取消原因和时间。用户在公开详情和“我的报名”中可以查看原因；后台列表、报名名单和概览同步使用数据库状态。

活动创建即发布，没有草稿或再次发布阶段；总名额及开始、结束、报名截止时间创建后固定。已取消活动不能恢复，当前不提供活动删除。首次取消会向当时的有效报名及候补者写入站内通知，重复取消不重复通知。网站继续只在本机和临时 CI 环境运行。

## 结束时间与展示状态

创建接口接受可选的 UTC Instant 字段 endsAt，缺失或 null 均不提供结束时间。开始、结束先截断到微秒，非空结束必须严格晚于开始，否则返回 400；V11 新增可空 DATETIME(6) 与同样的数据库 CHECK。旧活动不回填，开始、结束与名额创建后固定。

所有活动响应（包括旧数组、分页、详情、管理名单、本人报名及收藏中的活动）增加 endsAt，其余字段保持兼容。closed 表示活动取消或已开始，不表示活动已经结束；提前报名截止另用 registrationClosed，不改变用户取消与管理员编辑权限。STARTED 筛选仍包含所有未取消且已开始的活动；ONGOING 仅筛选已有结束时间且当前处于起止区间的活动，ENDED 仅筛选结束时间不晚于当前的活动，二者排除历史空结束时间。

| 时间条件（取消优先） | 页面状态 |
| --- | --- |
| 已取消 | 已取消 |
| 当前时刻早于开始 | 未开始 |
| 开始 ≤ 当前时刻 < 非空结束 | 进行中 |
| 当前时刻 ≥ 非空结束 | 已结束 |
| 已开始且结束为空 | 已开始；结束时间显示“未提供” |

接口与存储使用 UTC，表单和页面使用北京时间，表单不随浏览器所在时区改变解释。页面用一个可清理的时间边界计时器更新状态，不轮询接口；本地时间决定展示，写入权限仍由服务端核时。管理员确认、补签或撤销要求已开始、未取消及ACTIVE，结束后仍可纠错；本人定位签到还要求坐标和结束时间非空、`startsAt <= now < endsAt`、精度及300米距离均合格，见 [签到指南](checkin-export-guide.md)。

字段路径：CreateActivityPage / beijingInputToIso → api.createActivity → CreateActivityRequest.endsAt → ActivityService.create → NewActivity / ActivityMapper.insert → V11 ends_at → ActivityRow / ActivityView → activityPhase / 页面；日历沿 CalendarDownloadButton 的最新详情读取到 buildActivityCalendar。创建审计由 AuditLogService.created 同事务保存。

日历有结束时输出 UTC DTEND，没有结束时不输出 DTEND 或 DURATION。日历为秒精度：合法的微秒起止若截断后落在同一秒，下载明确报错，不生成结束等于开始的无效事件。详见 [架构](architecture.md#活动日历导出)。

## 报名截止时间

创建接口 POST /api/admin/activities 接受可选 UTC Instant 字段 registrationDeadline。缺失或 null 时沿用活动开始即停止报名；历史值保留 null，页面显示“活动开始时”。非空值与当前时刻、开始时间统一截断为 UTC 微秒，必须满足 当前 < 报名截止 < 开始，否则400 VALIDATION_ERROR。V12 新增可空 DATETIME(6) registration_deadline 和严格早于开始的 CHECK，不回填、不改旧迁移。

所有活动响应包含 registrationDeadline 和 registrationClosed；后者表示取消、已开始或非空截止时间不晚于本次查询时刻。closed 保持取消或开始的原语义。报名事务先锁活动主键，再用单次 UTC 微秒时刻依次检查取消、开始、截止，等待锁期间跨过截止也返回409 REGISTRATION_CLOSED；新报名、重新报名、加入候补和截止后的重复报名请求均不写入。已取消/已开始仍优先返回原ACTIVITY_CANCELLED/ACTIVITY_CLOSED。

截止后，ACTIVE/WAITING 仍可在开始前取消；有效报名取消仍按 updated_at,id FIFO 递补已有候补并同事务通知，取消候补不递补。管理员编辑、封面、整场取消、开始后签到补录及日历下载不受提前截止影响，固定截止字段不接受编辑额外参数覆盖。CREATE审计记录报名截止值，历史审计不补写。

公开与管理OPEN/FULL过滤排除报名已截止的活动，UPCOMING仍包含所有未取消且未开始活动。公开summary的可报名活动数及剩余名额、管理fullActivities/availableSeats排除截止；管理upcomingActivities仍表示全部未开始活动。集合/统计沿用一次UTC微秒时刻与只读快照，不新增筛选或统计字段。页面独立显示“报名已截止”，本地边界计时器更新标签和按钮，不轮询接口；集合与统计跨边界后手动刷新。

字段路径：CreateActivityPage / registrationDeadlineInputError / activityCreateRequest → CreateActivityRequest → ActivityService / NewActivity / ActivityMapper → V12 → ActivityRow / 本人报名与收藏联表 / ActivityView。写入约束由RegistrationService锁后核时，显示和控制由activityRegistrationClosed处理；活动相位仍由activityPhase处理。

## 管理员复制活动

管理列表（桌面及手机）与活动详情提供仅管理员可见的“复制活动”，未开始、进行中、已结束和已取消活动均可作为来源。入口为 /admin/activities/new?copyFrom={id}，读取完成前不显示可提交表单；来源读取重新请求现有公开活动详情，不信任列表旧快照。

只预填 title、description、location、category、capacity，原标题保持不加后缀，开始、结束和报名截止均清空。开始必填、结束和报名截止可选，沿用各自严格时间校验，均按北京时间解释。提交复用原 POST /api/admin/activities，显式列出创建字段，不传 copyFrom/id/封面/人数/取消/人员或其他历史；发布创建新 ID、零报名人数和正常 CREATE 审计。封面在新活动发布后另传，原活动及关联历史保持。

copyFrom 缺失为普通发布且不读取来源；空值、重复、非正安全整数为明确错误，不自动降级为空白发布。来源不存在或网络失败可重新加载或进入普通发布。来源标题按纯文本显示，不渲染HTML；成功预填后不后台重填用户草稿，不写入本地存储。

新来源、普通发布切换和身份代次变化清理旧读取、草稿及提交；pathname 与来源共同构成请求作用域，迟到成功/错误/401/finally不得覆盖新表单、清除新pending或触发旧导航。只重置表单子区域，URL无关query/hash变化不重挂整页及Providers。登录返回保留copyFrom，取消返回既有活动管理列表，不增加来源导航协议。保护及异步顺序沿用统一API、AuthProvider、useAdminRead和useActivityMutation。

## 接口与输入

| 方法和路径 | 输入 | 成功结果与权限 |
| --- | --- | --- |
| `PATCH /api/admin/activities/{id}` | `{title,description,location,category?}` | 200，完整 `ActivityView`；ADMIN 且 CSRF 有效 |
| `POST /api/admin/activities/{id}/cancel` | `{reason}` | 200，完整 `ActivityView`；ADMIN 且 CSRF 有效 |

编辑字段去除首尾空白后不能为空，标题最多 100、介绍最多 10000、地点最多 200 个 Java 字符。取消原因去除首尾空白后为 1–500 个 Java 字符，原始输入不得包含 C0/C1 控制字符、换行、制表符或 Unicode 行/段分隔符 U+2028/U+2029。无效参数返回 400 `VALIDATION_ERROR`。

上段文本规则用于标题、介绍和地点。V8 的分类使用五种精确代码，单独变化也更新并追加 `EDIT`，省略或 `null` 则保留旧值，重复保存不追加；热锁投影、开始时间和名额规则不变。创建默认值、分类过滤和审计前后值见 [活动分类指南](activity-category-guide.md)。

Controller 的 `@Size` 也对原始字符串检查同一长度上限；不能发送超过上限的空白后指望服务层去除再接受。前端提交会先去除首尾空白，后端仍独立校验。

客户端只能提交上述业务字段。编辑中额外的 `capacity`、`startsAt`、`endsAt`、`registrationDeadline`、`cancelledBy` 或用户身份字段不会写入；实际操作人来自 Spring Security 的可信身份，角色由 `/api/admin/**` 权限规则检查。未登录返回 401，普通用户在真实有效 CSRF 下仍返回 403 `FORBIDDEN`，无效 CSRF 返回 403 `CSRF_INVALID`。不存在的活动返回 404 `ACTIVITY_NOT_FOUND`。

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
| 未开始且未取消、未截止 | 只改标题、介绍、地点和分类 | 关闭活动和报名，保存首次取消信息 | 沿用名额、幂等及候补 FIFO 规则 |
| 未开始且未取消、已截止 | 同上，截止时间固定 | 同上 | 报名409 REGISTRATION_CLOSED；仍可取消与递补已有候补 |
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

管理活动筛选新增 `CANCELLED`；`ALL` 包含全部活动，`UPCOMING`、`OPEN`、`FULL`、`STARTED`、`ONGOING`、`ENDED` 都排除已取消活动。概览新增 `cancelledActivities`，`totalActivities` 继续含取消活动，其他活动时间状态和可报名名额排除取消活动。`activeRegistrations` 和 `waitingRegistrations` 仍直接统计报名表对应状态；取消事务完成后，该活动不贡献这两个值。统计和页面的详细合同见 [架构说明](architecture.md#管理查询与统计口径)。

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
