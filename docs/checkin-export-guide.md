# 管理员签到、整场统计与 CSV 导出

管理员从 `/admin/activities` 或活动详情进入“报名名单”，查看有效报名者的到场情况，并下载全部符合筛选条件的记录。活动开始后才允许手工签到；当前没有结束时间，支持补录，不设置自动截止，也不提供撤销签到。项目继续在本机演示，复用 React、Spring Boot 和 MySQL。

## 资格与首次签到

签到请求没有请求体。Spring Security 检查 ADMIN 和 CSRF，操作人 ID 来自可信的 `AppUserDetails`，客户端不能代替指定管理员。

1. `CheckInService.checkIn` 开启独立 `READ_COMMITTED` 写事务，用 `ActivityMapper.lockById` 锁活动主键。
2. 在该活动内普通查询报名 ID；不存在或属于其他活动均返回 `REGISTRATION_NOT_FOUND`。
3. 拒绝已取消活动，再在取得活动锁之后读取一次服务端 UTC 微秒时间。`starts_at <= now` 才允许签到，等待锁期间跨越开始时间的请求按取得锁后的时间判断。
4. 只有 `ACTIVE` 有效报名可签到；`WAITING`、`CANCELLED` 不适用。
5. 首次请求保存 `checked_in_at` 与可信的 `checked_in_by`，随后读取名单行返回。重复或并发请求保留首次时间、操作人 ID，不覆盖为后来的管理员。

签到在报名表只更新两个签到字段，并在同一事务追加 V6 的首次 `CHECK_IN` 操作记录；保留报名状态、`created_at`、`updated_at`、人数、候补队列及通知。它与报名、用户取消、组织者取消和编辑共享同一活动主键锁，不额外锁不存在的报名键。包括操作记录插入在内的任何数据库失败都回滚本次写入。名单和 CSV 中管理员昵称是当前数据库资料，可能随资料修改变化，首次身份由保存的用户 ID 指向；V6 操作记录另保存当时的操作人与目标用户名称快照，不随之后改名变化。两者不能混为同一种昵称口径，详见 [管理员操作记录指南](audit-log-guide.md)。

V5 `V5__add_registration_check_in.sql` 给 `registrations` 增加可空 UTC `DATETIME(6)` 和用户外键。CHECK 要求两字段同时为空，或同时非空且状态为 `ACTIVE`；外键 `ON DELETE RESTRICT` 防止删除被签到历史引用的用户。旧记录保持两个字段为空，没有补签到或覆盖旧迁移。约束不负责验证管理员角色或开始时间，这些业务判断由可信服务层完成。

## 接口与统计合同

| 方法与路径 | 行为 | 权限 |
| --- | --- | --- |
| `GET /api/admin/activities/{id}/registrations` | 筛选、分页、活动详情与整场签到统计 | ADMIN |
| `POST /api/admin/activities/{id}/registrations/{registrationId}/check-in` | 保存首次签到，返回当前名单行，无请求体 | ADMIN，需 CSRF |
| `GET /api/admin/activities/{id}/registrations/export` | 下载全部符合两类筛选的 CSV | ADMIN |

名单仍默认 `page=1`、`pageSize=10`，每页 1–100 条。`status` 为 `ALL|ACTIVE|WAITING|CANCELLED`，新增 `checkInStatus` 为 `ALL|CHECKED_IN|NOT_CHECKED_IN`，两者默认 `ALL`、区分大小写、按 AND 组合。已签到和未签到都只匹配有效报名者；例如 `WAITING` 与 `NOT_CHECKED_IN` 组合为空，而非把候补也算作未到场。

分页响应保留 `{activity,items,total,page,pageSize}` 并增加：

```json
{
  "summary": {
    "activeRegistrations": 12,
    "checkedInRegistrations": 3,
    "notCheckedInRegistrations": 9
  }
}
```

这三个数表示整场活动全部 `ACTIVE`，不受页码或两类筛选影响，上述数字只是合同示例。`total` 仍是本次筛选后的总数。名单行保留原报名及用户字段，并增加 `checkedInAt`（UTC 或 null）、`checkedInBy`（用户 ID 或 null）、`checkedInByDisplayName`（当前管理员昵称或 null）。候补和已取消的签到状态在页面与 CSV 显示“不适用”。

活动、整场统计、筛选总数与当前页在 `AdminService` 的只读 `REPEATABLE_READ` 事务内共享一致性快照，按 `updated_at DESC, id DESC` 排序。签到不更新 `updated_at`，因此不会让签到者跳到名单顶部或干扰候补 FIFO。并发签到提交后，本次读取仍使用原快照，下一次刷新才反映新结果；只读查询不增加活动写锁。

常见错误沿用 JSON `{code,message}` 与服务端 `X-Request-Id`：

| HTTP / code | 条件 |
| --- | --- |
| 401 / `UNAUTHENTICATED` | 未登录或会话已失效 |
| 403 / `FORBIDDEN`、`CSRF_INVALID` | 非管理员，或签到缺少/使用无效 CSRF |
| 404 / `ACTIVITY_NOT_FOUND`、`REGISTRATION_NOT_FOUND` | 活动不存在，或报名不在该活动内 |
| 409 / `CHECK_IN_NOT_OPEN` | 未到活动开始时间 |
| 409 / `REGISTRATION_NOT_ACTIVE`、`ACTIVITY_CANCELLED` | 非有效报名或活动已取消 |
| 400 / `VALIDATION_ERROR` | 非法分页或筛选状态 |
| 413 / `EXPORT_TOO_LARGE` | 匹配导出记录超过 20,000 条 |

两个新接口纳入固定日志和指标路由，不把报名 ID、昵称、筛选参数或 CSV 内容写进请求日志。实例内指标仍只表示当前 JVM，不能将跨实例或不同路由的 P95 平均为系统 P95。

## 文件合同与 Excel 查看

导出只读取 `status` 与 `checkInStatus`，默认均为 `ALL`。分页参数不能把导出缩成当前页；服务端在同一只读快照内计数并读取完整匹配集合，最多 20,000 条，超限返回明确 JSON 错误，不截断冒充完整文件。空集合可以成功下载，内容只有表头。

响应为 `text/csv;charset=UTF-8`、`Content-Disposition: attachment; filename="activity-{id}-registrations.csv"`，并设置 `Cache-Control: no-store`。文件以 UTF-8 BOM 开头，记录使用 CRLF，各字段包在双引号内，内部双引号加倍；昵称中的逗号、引号或换行仍属于同一字段。字段顺序如下：

| 字段 | 内容 |
| --- | --- |
| 报名记录ID、用户名、昵称 | 当前报名及用户资料 |
| 报名状态、签到状态 | 中文状态，有效报名者才适用签到 |
| 首次报名时间、报名更新时间、签到时间 | 表头注明北京时间，格式 `yyyy-MM-dd HH:mm:ss`；空签到时间留空 |
| 签到管理员ID、签到管理员昵称 | 首次操作人 ID 与当前昵称；未签到留空 |

接口和数据库保留 UTC 微秒，文件按北京时间显示到秒，展示精度不改变首次审计数据。非空自由文本和 ID 在双引号内部加 Tab 前缀，避免公式前缀触发 Excel 计算，并按文本处理数值 ID；固定中文状态和时间不添加前缀。原始昵称仍保存在数据库中，导出保护不改写账号资料。

这是供人使用 Excel 查看、筛选和交接的文件，Tab 会成为底层字段的一部分，不是无损原始数据导入格式。不同表格工具处理方式可能不同；策略与取舍参考 [OWASP CSV Injection 指引](https://community.owasp.org/attacks/CSV_Injection)。本项目验证 CSV 字节、字段和浏览器下载，不把这些断言称为所有 Excel 版本或再次保存后的兼容证明。

## 页面与请求生命周期

名单上方显示整场有效报名、已签到、未签到三项真实统计，加载与失败为 `—`。报名和签到筛选可共同使用，改变筛选或每页数量回到第一页；签到成功后重新读取当前条件，未签到末页记录减少导致越界时回到最后合法页，最少第一页。

未开始时提示到开始时间后刷新名单，没有轮询。对有效未签到者点击“确认签到”后，弹窗展示账号、昵称与不可撤销说明，确认过程中禁止重复提交。非有效报名者显示“不适用”，已签到者显示结果。表格内部横向滚动，操作列固定在右侧，桌面与手机共用现有蓝白后台布局。

统一 `api.ts` 处理 JSON 与 CSV，身份仍只由现有 `AuthProvider` 管理：

- CSV 非成功响应按 JSON 错误解析，保留业务 code 与合法请求编号，不把错误正文保存成文件。成功文件只接受 `text/csv`；GET 不自动获取 CSRF 或重试。
- 签到写入继续只对明确 403 `CSRF_INVALID` 刷新 Token 并重试一次，普通拒绝、未知错误和第二次 CSRF 失败可见。
- 读取、签到与下载同时核对可信账号请求票据的认证代次、取消信号与页面状态。页面进一步核对活动、筛选、页码和刷新版本；同一账号重新登录也使旧票据失效。
- 页面离开或条件变化时取消旧请求，迟到成功不能更新新名单、提示旧成功或下载，迟到 401 不能退出新会话。导出使用点击时的两类筛选，不携带客户端身份或分页。
- 浏览器下载只在当前请求仍有效时创建临时链接，点击前再次检查，结束时移除链接并释放对象 URL。网络失败可以重试；服务端已提交但响应丢失时，签到重试仍保留首次审计。

## 阅读、验证与面试演示

按一次签到请求阅读 `AdminRegistrationsPage → AdminRegistrationTable/useRosterActions → api.ts → AdminController → CheckInService → ActivityMapper/AdminMapper → V5`，再沿 `CheckInService → AuditLogService.checkedIn → AuditLogMapper → V6` 查看首次事件、当前数据库名称快照与 `MANDATORY` 同事务回滚；重复签到在追加之前返回首次结果。随后沿 `AdminService.roster/exportRoster → AdminMapper/RegistrationCsv` 比较同快照的统计、过滤、排序和完整导出。

`CheckInIntegrationTest` 使用真实 MySQL，覆盖开始时间边界、等待活动锁期间越过开始时间、可信身份与 CSRF、跨活动报名 ID、重复与并发首次信息、异常回滚、V5 约束、两类筛选、整场统计及并发中的读取快照。`RegistrationCsvTest` 验证编码、字段转义与文本保护；导出边界检查 20,000 条成功和超限拒绝，不用 H2 替代锁或快照行为。

前端 `api.test.mjs` 验证文件响应、错误编号、身份与分页剔除、CSRF 重试边界和取消信号；`checkin.test.mjs` 验证资格、对象 URL 清理和同账号重登后的旧下载阻断。`e2e/checkin.spec.ts` 用本轮准确归属记录覆盖桌面/手机真实签到、筛选统计、末页修正、下载内容、网络失败、迟到成功/错误与账号切换。默认 Compose 与 Redis 双实例验证针对真实服务及数据库，不以模拟序列化代替跨实例行为。

清理先核对活动归属和账号外部引用，包含 `checked_in_by` 与操作记录 `actor_user_id`；若本轮账号为外部活动执行过签到或留有操作记录，拒绝整次清理。另检查操作记录的报名与所属活动一致，异常跨活动绑定在任何 DELETE 前拒绝；原管理员作为本轮活动 actor 是合法引用，原账号与其他历史保留。V9 收藏还需通过准确用户/活动对的归属证明，外部引用拒绝；先删已证明收藏，再在同一事务按操作记录、通知、报名、活动、用户顺序删除本轮记录。当前环境核验 V1–V9、六张业务表、活动分类、签到列及用户凭据版本；历史 V2 性能实验只查询原三表，不读取新增签到、通知、操作记录或凭据版本，独立合同保持，不把当前业务写成历史 SQL 优化收益。归属保护与阅读路径见 [管理员操作记录指南](audit-log-guide.md)。

具体执行数量、浏览器下载是否通过及 CI 结果统一见 [验证记录](verification.md)。复现与精确清理见 [交付指南](delivery-guide.md)，跨实例身份及持久化见 [共享 Session 指南](shared-session.md)。测试代码存在与实际运行通过需要分别说明。

面试时用新活动让参与者在开始前报名，等自然到达开始时间后刷新名单，确认签到，再切换未签到筛选与下载 CSV。解释相同活动锁、首次审计幂等、整场统计与筛选总数区别，以及 Excel 人工查看保护的取舍。手工演示不修改已有数据的开始时间，成功签到不能撤销，活动与历史保持保存；完整可选流程见 [演示指南](demo-guide.md)。
