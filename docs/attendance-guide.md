# 活动签到分析：当前进度与统计口径

管理员在“概览”的“活动签到分析”模块按活动开始日期查看签到进度，并进入某场活动的报名名单。数据来自真实MySQL；当前签到包括管理员确认与本人定位，管理员在结束后仍可补签或撤销，因此数字表示查询时刻的当前状态，未签到不等于最终缺席。方式、版本和更正规则见 [签到指南](checkin-export-guide.md)。

## 统计什么

- 以活动的北京时间开始日期筛选，包含开始日和结束日；只纳入未取消、已经开始的活动。
- 活动场次统计整个匹配集合，包括没有有效报名的活动。
- 有效报名只计 `ACTIVE`，已签到是其中 `checked_in_at` 非空的子集；未签到为有效报名减已签到。候补与取消记录不进入分母。
- 整体签到比例是整个集合的已签到总人次除以有效报名总人次，乘 100 后四舍五入保留两位，不能平均每场活动的百分比。有效报名为 0 时返回 `null`，页面显示“不适用”。
- 上方统计覆盖全部匹配活动，不随当前页改变。每场进度使用该场自己的分子和分母，活动名额只作资料展示。

例如两场活动分别为 1/1 和 1/9，整体为 2/10，即 20%，不是两场比例的平均值。报名是人次，同一用户参加不同活动分别计数。

当前报名记录会复用，状态和更新时间也会变化；管理员操作记录只保存四类管理员动作。不能从这些表推导历史每日新增报名、累计取消率或候补递补率，本模块不展示这些指标。

## 接口、日期与查询快照

`GET /api/admin/attendance` 仅允许 ADMIN，沿用可信 Session 权限检查；匿名 401、普通用户 403。参数如下：

| 参数 | 合同 |
| --- | --- |
| `from`、`to` | 必须同时提供，严格 `YYYY-MM-DD`；同时省略时采用服务端北京时间今天及前 29 天 |
| 日期范围 | 2000-01-01 至 2100-12-31，开始日不晚于结束日，含首尾最多 366 天；空字符串、无效日期和单个日期均返回 400 |
| `page`、`pageSize` | 默认 1、10；页码至少 1，每页 1–100 条；非法值返回 400 |

返回 `{items,total,page,pageSize,from,to,asOf,summary}`。`asOf` 为本次读取的 UTC 微秒时间；`summary` 包含 `totalActivities`、`activeRegistrations`、`checkedInRegistrations`、`notCheckedInRegistrations` 和 `checkInRate`。列表项包含活动 ID、标题、地点、开始时间、名额和该场四项报名/签到数值，不暴露报名者或签到管理员的资料。

服务端只取一次 Clock，转换北京时间日期边界为 UTC 半开区间，并用同一个时刻判断活动已经开始。SQL 对原始 `starts_at` 作范围比较，不对列应用日期转换；总量聚合与当前页联表读取在只读 `REPEATABLE_READ` 事务中共用快照。活动按 `starts_at DESC,id DESC` 排序，越界页返回真实总数与空列表，页面再修正。

一次请求有两次业务数据 SELECT，不逐条查询活动或报名名单；聚合、联表、排序和 OFFSET 仍有数据库工作，不能把两次查询说成成本恒定或已证明性能提高。实际查询计数、执行计划与运行结果统一见 [验证记录](verification.md)。

V7 后已登录 HTTP 访问另外执行一次凭据版本认证 SELECT，总共一次认证加两次业务读取。认证在业务只读快照之外，原两次业务查询与时钟合同保持；HTTP 和直接 Service 的查询计数分别验证，见 [改密指南](password-change-guide.md)。

签到分析迭代复用 V5 签到字段和当时的 V6 环境，没有新增迁移、索引、依赖或业务写流程。读取不修改报名、候补、通知、签到或操作记录；接口纳入固定请求日志和指标路由，不记录日期查询参数或响应正文。

## 页面与演示

概览保留原有总览卡片和近期活动。签到分析采用独立日期草稿，点击查询后把已提交的日期、页码和每页数量保存在 `/admin/dashboard` 的 URL；首次默认日期也规范到 URL，刷新和浏览器历史保留该范围。日期或每页数量改变回第一页，越界页用 replace 修正；同条件查询和手动刷新会重新读取。

列表展示每场活动当前人数和签到进度，桌面表格、手机卡片。查询中或失败时不会把未知统计显示成 0；无匹配活动与没有有效报名分别有明确展示。页面注明北京时间和查询时刻，不轮询；通过名单链接检查具体记录，浏览器返回概览时重新读取。

列表请求复用统一 HTTP 客户端、认证代次、取消信号和请求作用域。改日期、离开页面、切换账号或同账号重新登录后，旧成功与旧错误不能覆盖新统计或退出新会话；未授权页面不挂载管理查询。原概览与近期活动的请求也使用相同的认证保护。

演示时选择已有已开始活动所在日期，比较全量统计与各场人数；在独立管理员会话中为有效报名者确认签到，返回概览手动刷新，核对已签到加 1、未签到减 1、有效报名不变。支持补录，因此只能说明当前进度变化，不能说活动已最终结算。

请求路径与接口说明见 [架构说明](architecture.md)，真实桌面/手机、MySQL、容器与双实例执行结果见 [验证记录](verification.md)。

## 按请求阅读代码

1. [AttendanceController](../backend/src/main/java/com/example/gather/api/AttendanceController.java) → [AttendanceService](../backend/src/main/java/com/example/gather/service/AttendanceService.java) → [AttendanceMapper](../backend/src/main/java/com/example/gather/mapper/AttendanceMapper.java)：核对权限、严格日期、单次时刻、快照与 SQL 聚合。
2. [AttendancePanel](../frontend/src/pages/AttendancePanel.tsx) → [attendanceQuery](../frontend/src/attendanceQuery.ts) → [useAdminRead](../frontend/src/pages/useAdminRead.ts)：跟踪日期草稿、URL、分页和过期响应；[AttendanceActivityList](../frontend/src/pages/AttendanceActivityList.tsx) 与 [AttendanceRate](../frontend/src/pages/AttendanceRate.tsx) 负责比较展示。
3. [AttendanceIntegrationTest](../backend/src/test/java/com/example/gather/AttendanceIntegrationTest.java)：真实 MySQL 的日期与开始边界、全量加权比例、两次读取及并发签到快照；实际执行计划不能直接当生产性能结论。
