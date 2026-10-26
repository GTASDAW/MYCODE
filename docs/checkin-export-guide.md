# 到场签到、管理员更正与 CSV 导出

用户从“我的报名”主动请求到场定位签到；管理员从 `/admin/activities` 或活动详情进入“报名名单”，确认到场、填写原因补签或撤销，并下载全部符合筛选条件的记录。管理员在活动开始后操作，结束后仍支持补录和纠错；本人定位签到只在活动进行窗口开放。项目继续在本机演示，复用 React、Spring Boot 和 MySQL。

## 资格与首次签到

原管理员 POST 保留无请求体调用，也接受可选 JSON `{ "expectedVersion": 0 }`。Spring Security 检查 ADMIN 和 CSRF，操作人 ID 来自可信的 `AppUserDetails`，客户端不能代替指定管理员。新管理页面始终提交所选行的版本。

1. `CheckInService.checkIn` 开启独立 `READ_COMMITTED` 写事务，用 `ActivityMapper.lockById` 锁活动主键。
2. 在该活动内普通查询报名 ID；不存在或属于其他活动均返回 `REGISTRATION_NOT_FOUND`。
3. 拒绝已取消活动，再在取得活动锁之后读取一次服务端 UTC 微秒时间。`starts_at <= now` 才允许签到，等待锁期间跨越开始时间的请求按取得锁后的时间判断。
4. 只有 `ACTIVE` 有效报名可签到；`WAITING`、`CANCELLED` 不适用。
5. 可选版本与锁后版本不一致时409 `CHECK_IN_VERSION_CONFLICT`。未签到时保存 `checked_in_at`、可信 `checked_in_by`、方式 `ADMIN` 并使版本加1；已签到则返回当前行，不覆盖原时间、管理员或定位方式。无版本的旧重复请求继续幂等。

每次真实签到与 `CHECK_IN` 操作记录同事务保存；保留报名状态、`created_at`、`updated_at`、人数、候补队列及通知。它与报名、用户取消、组织者取消和编辑共享同一活动主键锁，不额外锁不存在的报名键。包括操作记录插入在内的任何数据库失败都回滚本次字段和版本写入。名单和 CSV 中管理员昵称是当前数据库资料；操作记录另保存当时的操作人与目标用户名称快照，不随之后改名变化，详见 [管理员操作记录指南](audit-log-guide.md)。

V5 的签到时间和管理员外键保留。V15 仅新增可空 ASCII 精确匹配的 `check_in_method VARCHAR(16)` 与非负 `check_in_version BIGINT NOT NULL DEFAULT 0`；历史已签记录仅将方式回填 `ADMIN`，全部历史版本为0，原时间、管理员、`updated_at` 及历史审计保持。替换后的 CHECK 以 `IS TRUE` 严格限定三态：未签到的时间/管理员/方式全空；`ACTIVE` 的 `ADMIN` 已签到必须有管理员；`ACTIVE` 的 `SELF_LOCATION` 已签到管理员必须为空。外键仍限制删除，角色、时间、距离和归属由可信服务层检查。

## 本人到场定位签到

`POST /api/me/registrations/{registrationId}/check-in` 要求登录、CSRF及本人报名；非本人和不存在均返回404 `REGISTRATION_NOT_FOUND`。JSON 必填 `longitude`、`latitude`、`accuracyMeters`、`expectedVersion`，不读取客户端用户ID、角色、半径、距离或时间。原路径固定按WGS84编码处理，范围分别为±180/±90，精度必须 `0 < accuracyMeters <= 100` 米；版本为非负整数，不由额外JSON字段切换编码。

普通“我的报名”只提供“到场签到”，固定使用标准WGS84接口，不展示坐标模式，不读取能力字段来切换算法；权限、超时及距离错误仍显示在对应按钮旁。定位结果持续异常时检查浏览器/系统的精确位置权限、重新定位或联系管理员现场确认。提高系统精度不等于保证输出坐标系改变，不按浏览器品牌、IP或距离大小猜编码，不双算择近或放宽300米/100米要求。

仅供本地开发排障的`POST /api/me/registrations/{registrationId}/check-in/gcj02`保留，后端`app.maps.gcj02-diagnostic-enabled`（环境变量`AMAP_GCJ02_DIAGNOSTIC_ENABLED`）默认false，正常部署和本机演示保持关闭；普通客户端不提供此方法或可自行开启的入口。关闭时合法认证/CSRF及合法正文请求在任何业务SELECT、Clock、上游或writer前返回503 `LOCATION_DIAGNOSTIC_DISABLED`，已签重复也不能绕过；伪造JSON、query或header无法开启。分页保留`locationCheckInGcj02Supported`兼容字段，但取真实配置、默认false，原六参Java构造也默认false；普通页面忽略该字段，旧数组与SQL次数保持。

开发者仅在独立本地/隔离环境显式开关为true时，诊断路径按GCJ-02解释原四字段、直接封装唯一比较点，不做转换，并保留配置就绪、归属、版本、精度、活动预检及锁后全部检查。该诊断不是通用定位适配或位置真实性证明，标准路径始终只转换一次且不受诊断开关影响；没有普通界面的切换、UA猜测、择近或自动回退。既有成功签到历史保留，模式或原位置不持久存储。

服务首次本人查询轻量联表预读活动取消状态、结束时间及坐标，先检查归属、版本和ACTIVE。未签到时，已取消或缺少结束时间/坐标直接返回业务409，不调用高德；已签到重复请求仍走原锁后读取路径且不转换。预检不增加SELECT或时钟读取，不提前拒绝尚未开始的请求；时间窗口仍按取得锁后的单次UTC微秒时刻判断，转换期间的活动或签到状态变化由锁后重核处理。

单点转换仍在活动写事务和行锁之外，仅使用后端独立 Web服务 Key、固定高德 HTTPS 端点，禁止重定向，沿用包含正文的5秒时限及2MiB响应上限。每个Java实例最多16个转换同时在途，包含传输及响应解析；满额不排队、不调用上游，立即503 `LOCATION_CHECK_IN_UNAVAILABLE`，调用结束或失败均释放名额。它是本实例资源保护，不是多实例共享限流。缺Key不调用，网络或响应失败同样503，不伪造成功、自动重试或以客户端点直接比较；配置及申请见 [地点指南](activity-location-guide.md#申请与本机配置)。

标准转换成功或显式GCJ-02取到单一比较点后，由独立 Spring 事务 `LocationCheckInWriter` 以 `READ_COMMITTED` 锁原活动主键，普通重读报名及单独的活动结束时间/坐标，不扩报名热锁列；重核本人、版本、ACTIVE、未取消及锁后单次UTC微秒时刻。必须同时有活动坐标和结束时间，且 `startsAt <= now < endsAt`；以服务端 Haversine 计算GCJ-02点与活动点距离，要求 `distance <= 300` 米，精度合格与距离合格是独立条件，不把100米加进半径。两种模式均成功写 `SELF_LOCATION`、时间、空管理员并使版本加1，追加可信本人为 actor 的 `CHECK_IN`，不持久存储坐标编码或原位置。

响应为本人 `MyRegistrationView`，包括 `checkedInAt`、`checkInMethod`、`checkInVersion`，不含管理员身份或更正原因。原始用户GPS不存数据库、审计、日志、浏览器地址栏URL或浏览器持久存储；后端转换请求需把该单点交给提供商，不能声称完全没有对外发送位置。页面只在主动点击时定位，不轮询；权限拒绝、无位置、精度不足或超时有中文反馈且需手动重试。坐标与精度由终端提供，距离校验不等于防伪定位或真实到场证明。真实手机需要可信HTTPS及定位权限，不能把视口模拟当作设备GPS或提供商真实转换，详见 [手机限制](activity-location-guide.md#设备定位与手机限制)。

前端进入筛选/认证作用域时重置本次定位或提交状态及错误；切到其他条件后再返回原URL也从可操作状态开始。离开旧作用域仍取消请求，旧定位回调及POST成功、错误、收尾不能恢复旧状态或清除新请求的busy。未知提交结果仍先刷新核对，不自动重提POST。

定位失败、权限拒绝或页面侧10秒兜底超时时，按钮恢复可操作，错误按报名ID显示在对应按钮旁，并通过aria-describedby关联；记录已签/失效时仍可保留反馈，若记录不在当前列表则页顶回退，避免同一错误重复渲染。浏览器记住拒绝后可能不再弹框，提示用户到网站信息/权限及手机系统中重新允许，不自动改权或重试；原生无回调也不能永久保留busy，拿到坐标后则清定位计时器，原POST未知结果的核对流程保持。

## 管理员补签与撤销

`PATCH /api/admin/activities/{id}/registrations/{registrationId}/check-in` 必填 `{ "checkedIn": false, "reason": "核实后撤销", "expectedVersion": 1 }`。`checkedIn` 使用必填可空包装校验，缺失不会默认撤销；原因是1–500字的非空单行文本，版本必填。权限和资格沿用管理员正常签到，结束后仍可纠错；跨活动报名仍404。

锁后先比较版本，冲突409；目标状态与当前一致时不写入、不追加审计或增加版本。补签保存当前可信管理员和时间，方式为 `ADMIN`；撤销清当前时间、管理员和方式。真实变化均版本加1，分别追加 `CHECK_IN` 或 `CHECK_IN_REVOKE`；原因仅进管理员审计，撤销保留原时间、方式、管理员的前值及全部历史事件。撤销后仍在有效窗口时可用新版本重新定位签到，产生新事件；旧定位请求即使晚到也会因版本冲突被拒。响应丢失时先刷新核对，不自动重提未知结果。

## 接口与统计合同

| 方法与路径 | 行为 | 权限 |
| --- | --- | --- |
| `GET /api/admin/activities/{id}/registrations` | 筛选、分页、活动详情与整场签到统计 | ADMIN |
| `POST /api/admin/activities/{id}/registrations/{registrationId}/check-in` | 正常确认，空体兼容或可选 expectedVersion，返回当前名单行 | ADMIN，需 CSRF |
| `PATCH /api/admin/activities/{id}/registrations/{registrationId}/check-in` | 必填状态、原因及版本的补签/撤销，返回当前名单行 | ADMIN，需 CSRF |
| `POST /api/me/registrations/{registrationId}/check-in` | 本人定位签到，返回本人记录 | 已登录且本人，需 CSRF |
| `POST /api/me/registrations/{registrationId}/check-in/gcj02` | 仅开发者显式开启的本地坐标诊断，默认503拒绝 | 已登录且本人，需 CSRF；另需服务端诊断开关 |
| `GET /api/admin/activities/{id}/registrations/export` | 下载全部符合关键词、报名状态、签到状态及方式的 CSV | ADMIN |

名单仍默认 `page=1`、`pageSize=10`，每页 1–100 条。`status` 为 `ALL|ACTIVE|WAITING|CANCELLED`，`checkInStatus` 为 `ALL|CHECKED_IN|NOT_CHECKED_IN`，两者默认 `ALL`、区分大小写、按 AND 组合。已签到和未签到都只匹配有效报名者；例如 `WAITING` 与 `NOT_CHECKED_IN` 组合为空，而非把候补也算作未到场。

名单及CSV另接受 `checkInMethod`：省略为 `ALL`，只接受精确 `ALL|SELF_LOCATION|ADMIN`，显式空串、大小写错误或其他值返回400 `VALIDATION_ERROR`。界面分别显示“全部方式”“本人定位”“管理员确认”。`ADMIN` 包括正常管理员确认、人工补签及V15已回填ADMIN的历史签到；`ALL`保留未签到等方式为空的记录。该条件与关键词和两类状态共同按AND筛选 `items`、`total` 及CSV全集，例如“未签到＋本人定位”为空，不自动改变其他条件。原Service重载省略方式时仍委托ALL，不改变旧响应或CSV11列。

名单与导出均接受可选 `keyword`，默认空，最多200个Java字符；省略或空值保持原接口行为，超长返回400 `VALIDATION_ERROR`。关键词按账号或当前昵称字面包含匹配，与两类状态及签到方式按AND组合；使用绑定参数的LOCATE，百分号、下划线、引号和反斜线不作为通配符或SQL。直接API保留原始关键词，页面提交时去除首尾空白；匹配沿用数据库既有字符排序规则，不搜索签到管理员昵称。

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

这三个数表示整场活动全部 `ACTIVE`，不受页码、关键词、两类状态或签到方式筛选影响，上述数字只是合同示例。`total` 仍是本次筛选后的总数。名单行保留 `checkedInAt`（UTC或null）、`checkedInBy`、`checkedInByDisplayName`，并新增 `checkInMethod`（`ADMIN|SELF_LOCATION|null`）、`checkInVersion`。后两个管理员字段仅表示管理员签到，定位签到为空；候补和已取消在页面与CSV显示“不适用”。统计仍按ACTIVE及当前非空签到时间，不按方式另算，也不增SQL次数。

活动、整场统计、筛选总数与当前页在 `AdminService` 的只读 `REPEATABLE_READ` 事务内共享一致性快照，按 `updated_at DESC, id DESC` 排序。签到不更新 `updated_at`，因此不会让签到者跳到名单顶部或干扰候补 FIFO。并发签到提交后，本次读取仍使用原快照，下一次刷新才反映新结果；只读查询不增加活动写锁。

关键词、两类状态及签到方式的计数与列表/CSV共用 `AdminMapper.ROSTER_FILTER`，计数联表users读取相同的当前昵称；昵称或签到方式在两次读取之间提交变化时，本次查询仍按原快照返回，下次刷新才改变匹配集合。分页保持活动、整场统计、匹配计数、当前页四次业务SELECT；导出为活动、匹配计数、全集三次，认证凭据版本查询另计。当前门禁为V15，不新增索引或依赖。

常见错误沿用 JSON `{code,message}` 与服务端 `X-Request-Id`：

| HTTP / code | 条件 |
| --- | --- |
| 401 / `UNAUTHENTICATED` | 未登录或会话已失效 |
| 403 / `FORBIDDEN`、`CSRF_INVALID` | 非管理员，或签到缺少/使用无效 CSRF |
| 404 / `ACTIVITY_NOT_FOUND`、`REGISTRATION_NOT_FOUND` | 活动不存在，或报名不在该活动内 |
| 409 / `CHECK_IN_NOT_OPEN` | 未到活动开始时间 |
| 409 / `REGISTRATION_NOT_ACTIVE`、`ACTIVITY_CANCELLED` | 非有效报名或活动已取消 |
| 409 / `CHECK_IN_VERSION_CONFLICT` | 读取后签到状态发生变化，需刷新核对 |
| 409 / `LOCATION_CHECK_IN_CLOSED`、`LOCATION_OUT_OF_RANGE` | 定位窗口关闭，或转换后超过300米 |
| 409 / `LOCATION_CHECK_IN_UNAVAILABLE` | 活动缺坐标或结束时间 |
| 503 / `LOCATION_CHECK_IN_UNAVAILABLE` | 未配置独立Web服务Key，或提供商转换失败 |
| 400 / `VALIDATION_ERROR` | 非法分页、筛选状态或超长关键词 |
| 413 / `EXPORT_TOO_LARGE` | 匹配导出记录超过 20,000 条 |

签到及导出接口纳入固定日志和指标路由，不把报名ID、昵称、筛选参数、GPS、Key或CSV正文写进请求日志。实例内指标仍只表示当前 JVM，不能将跨实例或不同路由的 P95 平均为系统 P95。

## 文件合同与 Excel 查看

导出读取 `status`、`checkInStatus`、`checkInMethod` 和 `keyword`，默认分别为 `ALL`、`ALL`、`ALL`、空。分页参数不能把导出缩成当前页；服务端在同一只读快照内计数并读取完整匹配集合，最多 20,000 条，超限返回明确 JSON 错误，不截断冒充完整文件。空集合可以成功下载，内容只有表头。

响应为 `text/csv;charset=UTF-8`、`Content-Disposition: attachment; filename="activity-{id}-registrations.csv"`，并设置 `Cache-Control: no-store`。文件以 UTF-8 BOM 开头，记录使用 CRLF，各字段包在双引号内，内部双引号加倍；昵称中的逗号、引号或换行仍属于同一字段。字段顺序如下：

| 字段 | 内容 |
| --- | --- |
| 报名记录ID、用户名、昵称 | 当前报名及用户资料 |
| 报名状态、签到状态 | 中文状态，有效报名者才适用签到 |
| 首次报名时间、报名更新时间、签到时间 | 表头注明北京时间，格式 `yyyy-MM-dd HH:mm:ss`；空签到时间留空 |
| 签到管理员ID、签到管理员昵称 | 当前管理员签到的操作人ID与当前昵称；未签到或定位签到留空 |
| 签到方式（新增最后一列） | `管理员签到`、`定位签到`；未签到留空，原十列顺序保持 |

接口和数据库保留 UTC 微秒，文件按北京时间显示到秒，展示精度不改变首次审计数据。非空自由文本和 ID 在双引号内部加 Tab 前缀，避免公式前缀触发 Excel 计算，并按文本处理数值 ID；固定中文状态和时间不添加前缀。原始昵称仍保存在数据库中，导出保护不改写账号资料。

这是供人使用 Excel 查看、筛选和交接的文件，Tab 会成为底层字段的一部分，不是无损原始数据导入格式。不同表格工具处理方式可能不同；策略与取舍参考 [OWASP CSV Injection 指引](https://community.owasp.org/attacks/CSV_Injection)。本项目验证 CSV 字节、字段和浏览器下载，不把这些断言称为所有 Excel 版本或再次保存后的兼容证明。

## 页面与请求生命周期

名单上方显示整场有效报名、已签到、未签到三项真实统计，加载与失败为 `—`。账号/昵称关键词与报名和签到筛选可共同使用，提交搜索、改变状态筛选或每页数量回到第一页；签到成功后重新读取当前已提交条件，未签到末页记录减少导致越界时replace到最后合法页，最少第一页。

已提交条件按keyword、status、checkInStatus、checkInMethod、page、pageSize顺序存于 `/admin/activities/{id}/registrations` URL，省略默认值；输入草稿独立，未提交的文字不改变名单或CSV。查询与Enter提交，同条件仍重新读取；切换状态、方式或每页数量回第一页，保留已提交关键词且不隐式提交草稿。重置清空关键词、状态及方式、回第一页并保留每页数量，手动刷新使用已提交条件。非法URL方式归ALL，其他有效条件保留；非法状态和数字归默认，超长关键词清空并提示，无关参数规范化移除。刷新、浏览器历史和登录返回保留条件，不因筛选/hash重挂页面和Providers。名单进入同活动详情携带规范来源，只有当前管理员且活动编号一致可“返回报名名单”，外部路径、其他活动或非管理员不能扩展原公开来源白名单。

未开始时提示到开始时间后操作，页面在开始边界更新按钮，没有轮询。对有效未签到者点击“确认签到”后，弹窗展示账号、昵称；另用“更正签到”选择补签或撤销并填写原因，提交带所选行版本，过程中禁止重复提交。版本冲突关闭旧选择并刷新核对，非有效报名者显示“不适用”。表格内部横向滚动，操作列固定在右侧，桌面与手机共用现有蓝白后台布局。

统一 `api.ts` 处理 JSON 与 CSV，身份仍只由现有 `AuthProvider` 管理：

- CSV 非成功响应按 JSON 错误解析，保留业务 code 与合法请求编号，不把错误正文保存成文件。成功文件只接受 `text/csv`；GET 不自动获取 CSRF 或重试。
- 签到写入继续只对明确 403 `CSRF_INVALID` 刷新 Token 并重试一次，普通拒绝、未知错误和第二次 CSRF 失败可见。
- 读取、签到与下载同时核对可信账号请求票据的认证代次、取消信号与页面状态。页面进一步核对活动、筛选、页码和刷新版本；同一账号重新登录也使旧票据失效。
- 页面离开或已提交条件变化时取消旧请求，作用域包含关键词、签到方式等URL条件及认证代次；迟到成功不能更新新名单、提示旧成功或下载，迟到401不能退出新会话，旧finally不能清除新操作状态。导出使用点击时已提交的关键词、两类状态及签到方式，不携带草稿、客户端身份或分页。
- 浏览器下载只在当前请求仍有效时创建临时链接，点击前再次检查，结束时移除链接并释放对象 URL。签到提交结果未知时提示刷新核对，不自动重提；再次使用旧版本将明确冲突。

## 阅读、验证与业务演示

管理员路径为 `AdminRegistrationsPage → AdminRegistrationTable/CheckInCorrectionModal/useRosterActions → api.ts → AdminController → CheckInService → ActivityMapper/AdminMapper → V5/V15`；本人路径为 `MyRegistrationsPage → useLocationCheckIn/nativeLocation → LocationCheckInController → LocationCheckInService → LocationCoordinateConverter → LocationCheckInWriter`。审计沿 `AuditLogService → AuditLogMapper → V6/V15` 查看同事务与前后值；名单及CSV沿 `AdminService.roster/exportRoster → AdminMapper/RegistrationCsv` 比较快照与字段顺序。

`CheckInIntegrationTest` 使用真实 MySQL，覆盖开始时间边界、等待活动锁期间越过开始时间、可信身份与 CSRF、跨活动报名 ID、重复与并发首次信息、异常回滚、V15严格三态约束、两类筛选、整场统计及并发中的读取快照。`RegistrationCsvTest` 验证编码、字段转义与文本保护；导出边界检查 20,000 条成功和超限拒绝，不用 H2 替代锁或快照行为。

前端 `api.test.mjs` 验证文件响应、错误编号、身份与分页剔除、CSRF 重试边界和取消信号；`checkin.test.mjs` 验证资格、对象 URL 清理和同账号重登后的旧下载阻断。`e2e/checkin.spec.ts` 用本轮准确归属记录覆盖桌面/手机真实签到、筛选统计、末页修正、下载内容、网络失败、迟到成功/错误与账号切换。默认 Compose 与 Redis 双实例验证针对真实服务及数据库，不以模拟序列化代替跨实例行为。

清理先核对活动归属和账号外部引用，包含 `checked_in_by` 与操作记录 `actor_user_id`；若本轮账号为外部活动执行过签到或留有操作记录，拒绝整次清理。另检查操作记录的报名与所属活动一致，异常跨活动绑定在任何 DELETE 前拒绝；原管理员作为本轮活动 actor 是合法引用，原账号与其他历史保留。收藏还需准确用户/活动对的归属证明；先删已证明收藏，再同事务按操作记录、通知、报名、活动、用户顺序清理。当前环境写入前及清理前核验V15、六张业务表、签到严格三态/非负版本与两个审计CHECK，兼顾原坐标、头像、截止/结束时间、封面、分类及凭据版本；历史V2的独立合同保持。归属保护见 [管理员操作记录指南](audit-log-guide.md)。

具体执行数量、浏览器下载是否通过及 CI 结果统一见 [验证记录](verification.md)。复现与精确清理见 [交付指南](delivery-guide.md)，跨实例身份及持久化见 [共享 Session 指南](shared-session.md)。测试代码存在与实际运行通过需要分别说明。

演示使用独立新活动并在开始前报名，等自然开始后选择本人定位或管理员确认，再填写原因更正并查看审计与CSV。定位演示须另外核对真实Web服务Key、设备HTTPS和权限；不修改已有样例时间，不以模拟定位展示为真实到场证据。完整可选流程见 [演示指南](demo-guide.md)。
