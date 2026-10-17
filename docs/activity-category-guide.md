# 活动分类与筛选

活动使用固定单选分类。管理员发布时默认“未分类”，可在活动开始前、未取消时修改；发现页和活动管理按分类、关键词及状态共同查询。分类属于活动资料，不改变名额、报名、候补、签到或通知规则。

## 分类与兼容规则

| 代码 | 页面名称 |
| --- | --- |
| `UNCATEGORIZED` | 未分类 |
| `TECHNOLOGY` | 技术交流 |
| `SPORTS` | 运动户外 |
| `CULTURE` | 文化艺术 |
| `OTHER` | 其他 |

`ALL` 仅表示查询全部分类，不是可以保存的分类。代码区分大小写，不去除空白。第一版没有分类管理、多标签、分类字典接口或新的中间件。

[V8 迁移](../backend/src/main/resources/db/migration/V8__add_activity_category.sql) 增加 `activities.category`，非空默认 `UNCATEGORIZED`，CHECK 以精确二进制代码限定五值，防止数据库默认排序规则把小写或尾部空格当作合法代码。已有活动获得“未分类”，不根据标题推断，不补造历史审计；原迁移保持原样。

| 现有接口 | 分类行为 |
| --- | --- |
| `POST /api/admin/activities` | 可选 JSON `category`；省略或 `null` 默认未分类 |
| `PATCH /api/admin/activities/{id}` | 可选 JSON `category`；省略或 `null` 保留锁后读取的现值，显式 `UNCATEGORIZED` 可改回未分类 |
| `GET /api/activities/search` | 新查询参数 `category`，省略为 `ALL` |
| `GET /api/admin/activities` | 同样按 `category` 筛选，默认 `ALL` |

写请求中的空串、未知代码和 `ALL` 返回 400 `VALIDATION_ERROR`；查询中的空串、未知代码同样拒绝。管理员写接口仍检查角色和 CSRF，不接受客户端身份。

所有 `ActivityView` 增加 `category`，包括旧数组、详情、管理分页、报名操作返回和个人报名内嵌活动。旧字段、数组结构和排序保留；个人报名另有独立联表投影，需要同步分类，不能回到逐条查询活动。本人接口增加内嵌分类字段，页面保留原有状态、时间与签到展示，不增加分类筛选或改变四项全量统计。

## 查询、编辑与追溯

分类条件进入公开和管理共用的 `ActivityQuerySql.FILTER`，与字面关键词和状态按 AND 组合。例如 `category=TECHNOLOGY&status=OPEN` 只返回技术交流中的可报名活动。`ALL` 不增加分类条件；“未分类”可以单独查询。

公开 `total`、两项 `summary` 和当前页使用同一分类条件，统计覆盖全部匹配活动。聚合与分页共用只读 `REPEATABLE_READ` 快照和一次 UTC 微秒时刻，保持 `starts_at ASC,id ASC` 排序；管理分页同样使用一致快照。分类在两次读取间被其他事务修改，本次响应仍读取原快照，下次刷新才能看到新分类。初版没有新增分类索引或性能收益声明，实际 SQL、执行计划及结论以验证记录为准。

分类编辑沿用原活动主键锁和 `READ_COMMITTED` 事务。先检查未开始、未取消，再通过编辑资料查询读取旧分类；用 Java 字符串精确比较，真实变化才更新。报名热路径的四字段锁定投影保持，分类不加入名额判断。

创建审计增加 `category` 初始代码；分类单独变化也会生成一条 `EDIT`，保存真实前后代码。审计和业务同事务提交或回滚，重复保存不更新、不追加。详情按固定映射显示中文分类，旧记录缺少分类字段时按原内容展示，不回填新字段。

## 页面、URL 与阅读路径

发布和编辑表单提供五种分类，编辑回填现值；活动卡片、详情和管理列表显示中文标签。发现页和管理列表都可选“全部分类”，切分类或每页数量回第一页并保留其他已提交条件。

公开 URL 以 `/activities` 为入口，管理 URL 以 `/admin/activities` 为入口，两者保存 `keyword/status/category/page/pageSize`，省略默认值。公开默认每页 12，管理默认每页 10；公共关键词按字面保留空格，管理沿用去除首尾空格的提交规则。输入草稿与已提交查询分开，刷新、历史、同条件重新查询和越界 replace 均读取实际接口；非法 URL 分类规范化为 `ALL`，其他有效条件保留。

公开详情来源和登录返回的规范化同时识别分类，不能在安全过滤中丢掉 `category`。公共读取包含个人报名状态，因此匿名和已登录读取都核对认证代次、请求范围、取消信号及排队中的页码修正；同账号重登也会使旧响应失效。管理读取复用现有管理请求保护，发布和编辑提交复用带取消及认证代次的 mutation，避免旧成功或旧 401 影响新账号。

1. 从 [分类映射](../frontend/src/activityCategory.ts)、[公开 URL](../frontend/src/activityDiscovery.ts)、[管理 URL](../frontend/src/adminActivityQuery.ts) 阅读代码、中文名称与默认值，再查看发布、编辑和列表页。
2. 沿 `ActivityController/AdminController → ActivityService/AdminService → ActivityQuerySql/ActivityMapper/AdminMapper` 跟踪验证、共享条件、快照和分类编辑；比较 `RegistrationMapper.MY_VIEW_COLUMNS` 的独立个人投影。
3. 沿 `ActivityService → AuditLogService` 查看仅分类变化、无变化和同事务回滚；对照 [操作记录展示](../frontend/src/auditLogPresentation.ts) 的代码到中文映射。
4. 对照 [分类数据库回归](../backend/src/test/java/com/example/gather/ActivityCategoryIntegrationTest.java)、[分类浏览器场景](../e2e/category.spec.ts) 和 [验证记录](verification.md)。实际运行结果单独记录，不把测试存在写成已经通过。

当前环境与清理门禁升级到 V8，活动基线包含分类；只创建并清理准确归属的分类样例，保护原五表及外部引用。历史固定 V2 性能实验不读取分类，不改变其报告形状。演示可自行发布两种分类的未来活动，展示分类筛选、详情返回和一次分类变更审计；既有样例保留未分类，网站继续仅本地演示。
