# 集会 Gather：面试展示与讲解材料

这份材料用于快速介绍项目、准备简历和检验自己的理解。完整操作沿用 [五分钟演示指南](demo-guide.md)，源码阅读沿用 [学习指南](learning-guide.md)，现有追问见 [演示指南的回答依据](demo-guide.md#面试追问与回答依据)。网站目前仅在本地演示；下文描述的是仓库实现，不等于已经确认你独立完成或掌握了所有内容。

## 30 秒项目介绍

> 集会 Gather 是一个本地演示的活动报名平台，使用 React、TypeScript 和 Spring Boot，数据保存在 MySQL。用户可以搜索、收藏、报名和候补，管理员可以维护活动、上传封面、签到和追溯操作。我准备讲解四个设计：并发报名不超额、改密后旧会话失效、分页与统计共用快照，以及如何通过独立恢复确认备份可用。

这段话先介绍已经实现的系统。介绍个人工作时，再补一句经过自己确认的事实：“我实际负责或完成了【模块/设计/修复】，通过【运行方式/测试/演示】核验。”不要把尚未练习的内容填成“独立设计并熟练掌握”。

## 两分钟讲解顺序

提前按 [README](../README.md) 启动本机环境，并准备活动列表、我的报名、管理员名单和源码入口。两分钟展示以读取现有结果为主；需要实际发布、换账号和递补时，改用已有五分钟流程，不为了缩短演示直接修改数据库或已有活动的开始时间。

| 时间 | 展示与说法 | 要让面试官看见的事实 |
| --- | --- | --- |
| 0:00–0:25 | 使用上面的介绍，打开活动列表并筛选 | 前后端和 MySQL 连通，搜索与统计来自接口 |
| 0:25–0:55 | 展示我的报名，再展示管理员报名名单；使用普通窗口与无痕窗口，或两个独立浏览器上下文分别登录 | 用户与管理员的流程完整，个人签到只读，管理操作由后端校验权限 |
| 0:55–1:25 | 打开 `RegistrationService.register/cancel` 和 `ActivityMapper.lockById` | 同一活动先锁主键，再检查状态、更新人数和递补；事务异常一起回滚 |
| 1:25–1:50 | 展示个人分页的聚合与联表 SQL，以及已有验证入口 | 统计覆盖本人全部记录，列表和统计共用快照；应用数据 SELECT 次数有实际断言 |
| 1:50–2:00 | 说明本地运行与两种 Session 模式，邀请选择一个设计继续追问 | 默认内存 Session；可选 Redis 解决两个实例共享登录，数据库仍负责名额一致性 |

签到演示需要活动自然开始。需要演示候补、通知或签到写入时，按 [演示前准备](demo-guide.md#演示前准备) 新建属于这次演示的活动，不占用已有样例；手工发布的活动和历史会保留。

## 技术卡一：最后一个名额与候补递补

**从具体问题开始：** 活动只剩一个名额，两个人同时“先查询、再写入”，可能都被确认。目标不变量是 `ACTIVE` 数量等于活动人数，且人数不超过名额；`WAITING` 不占名额。

**解释实现：** 报名与取消使用 `READ_COMMITTED` 事务，先执行活动主键 `SELECT ... FOR UPDATE`，取得锁后检查开始时间和取消状态，再普通读取报名记录。同一活动的写操作依次处理；唯一约束保证同一用户和活动只有一条记录，事务保证人数、状态和真实递补通知一起提交或回滚。满员时入候补；取消有效报名后按 `updated_at ASC, id ASC` 递补最早的一人。重复操作读取已有状态，开放期间不会重复增减人数或重复入队。

**讲清取舍：** 活动行锁串行化同一活动，热门活动的吞吐受持锁时间影响。报名状态读取不再对不存在的键加锁，`READ_COMMITTED` 能读取前一个持锁事务提交后的状态；数据库约束和事务仍不可省略。事务内没有邮件等外部调用，现有通知是 MySQL 中的站内记录。

| 阅读入口 | 在代码或证据中找什么 |
| --- | --- |
| [RegistrationService](../backend/src/main/java/com/example/gather/service/RegistrationService.java) | `register`、`cancel`、`lockOpenActivity` 的事务、锁后检查、状态与人数分支 |
| [ActivityMapper](../backend/src/main/java/com/example/gather/mapper/ActivityMapper.java)、[RegistrationMapper](../backend/src/main/java/com/example/gather/mapper/RegistrationMapper.java) | 活动主键行锁、普通报名查询、FIFO 排序及状态更新时间 |
| [RegistrationIntegrationTest](../backend/src/test/java/com/example/gather/RegistrationIntegrationTest.java)、[NotificationIntegrationTest](../backend/src/test/java/com/example/gather/NotificationIntegrationTest.java) | 100 人竞争 10 个名额、重复操作、FIFO、跨活动首次插入、人数更新后插入失败回滚，以及通知与业务一起回滚 |
| [并发报名复盘](concurrency-review.md)、[站内通知指南](notification-guide.md)、[验证记录](verification.md) | 机制分工、真实 MySQL 验证与结论边界 |

可引用的结论是：给定真实 MySQL 并发用例最终为 10 条 `ACTIVE`、90 条 `WAITING`，人数为 10。它验证该场景的一致性，不代表生产容量或任意流量下的响应时间。

## 技术卡二：登录身份、CSRF、改密与共享 Session

**从具体问题开始：** 浏览器自动携带登录 Cookie，因此写接口还需要 CSRF 校验。隐藏管理按钮不能阻止直接调用接口；用户 ID 和角色必须取自可信登录身份。

**解释实现：** Spring Security 管理 Cookie Session，`/api/admin/**` 要求 ADMIN。前端统一客户端从 `/api/auth/csrf` 获取令牌，写请求放入指定头；登录和退出后刷新令牌。仅明确的 `CSRF_INVALID` 允许刷新后重试一次，`FORBIDDEN` 不重试。页面还检查认证代次、请求顺序和取消信号，旧成功不能覆盖新账号，旧 401 不能退出新会话；同账号重新登录也产生新代次。

**接着解释改密：** 登录从同一行读取密码哈希与 `credential_version`，Session principal 保留版本但清除密码。改密重新读数据库原哈希，校验通过后用可信用户 ID 和旧版本作条件，原子更新哈希并递增版本；BCrypt 计算不持有用户行锁，同一旧版本并发改密只有一个胜者。已登录业务请求在授权前各进行一次不缓存的版本查询：旧身份访问受保护接口返回 401，公开活动查询清除身份后匿名读取，数据库校验失败返回 503。已经通过认证的在途操作允许完成，不能声称改密撤回了这些操作。

**讲清取舍：** 默认 Session 存在单个 Java 进程内存，重启后重新登录。显式 `redis` profile 才启用 Spring Session Redis，让两个真实 Java 实例共用登录与 CSRF 状态；同组实例使用一致的 Cookie、命名空间和闲置时限。恢复登录还要求会话有效、Redis 数据仍在且可用。Redis 不保存剩余名额，不代替 MySQL 行锁，也没有自动形成高可用方案。

**可以继续追问：** 为什么不遍历删除 Redis 会话？版本校验让迟到保存的旧身份仍然失效，但每个已登录业务请求增加一次数据库读取。网络中断时密码可能已经更新，只能说“结果未确认，请重新登录确认”，不能声称回滚或自动重提。JS 代次校验不能撤销浏览器已经应用的 Cookie，旧响应还需避免删除新登录 Cookie 或覆盖新 CSRF。阅读 [改密指南](password-change-guide.md) 后，用自己注册的独立账号验证两个会话，不修改预置演示账号密码。

| 阅读入口 | 在代码或证据中找什么 |
| --- | --- |
| [SecurityConfiguration](../backend/src/main/java/com/example/gather/security/SecurityConfiguration.java)、[ActivityController](../backend/src/main/java/com/example/gather/api/ActivityController.java) | Session CSRF 仓库、服务端 ADMIN 规则、可信 principal 的用户 ID |
| [统一 HTTP 客户端](../frontend/src/api.ts)、[AuthProvider](../frontend/src/auth.tsx)、[认证请求保护](../frontend/src/authRequestGuard.ts) | Cookie 请求、令牌轮换与一次重试、同账号重登及迟到响应保护 |
| [PasswordChangeService](../backend/src/main/java/com/example/gather/service/PasswordChangeService.java)、[UserMapper](../backend/src/main/java/com/example/gather/mapper/UserMapper.java)、[CredentialVersionFilter](../backend/src/main/java/com/example/gather/security/CredentialVersionFilter.java) | 原哈希校验、带旧版本的原子更新、授权前版本读取与数据库故障拒绝放行 |
| [RedisSessionConfiguration](../backend/src/main/java/com/example/gather/config/RedisSessionConfiguration.java)、[Redis Compose overlay](../compose.redis.yaml) | 显式 profile、统一时限、两个后端与共享 Redis |
| [RegistrationIntegrationTest](../backend/src/test/java/com/example/gather/RegistrationIntegrationTest.java)、[客户端回归](../frontend/tests/api.test.mjs)、[个人请求回归](../frontend/tests/myregistrations.test.mjs) | 登录轮换、退出、权限、CSRF 重试边界与旧 401 保护 |
| [PasswordChangeIntegrationTest](../backend/src/test/java/com/example/gather/PasswordChangeIntegrationTest.java) | 并发改密、登录竞态、旧版本失效和回滚的实际断言 |
| [真实双实例验证脚本](../scripts/redis-session-check.mjs)、[共享 Session 指南](shared-session.md)、[验证记录](verification.md) | A/B 登录与 CSRF、重启、退出、真实闲置失效的已运行证据 |

## 技术卡三：个人分页与同一次读取快照

**从具体问题开始：** “我的报名”既要显示当前页，又要显示本人全部历史统计。若两次读取之间有人取消或签到，统计和列表可能不一致；逐条加载活动还会增加应用数据 SELECT 次数。

**解释实现：** 新接口用一次聚合同时取得筛选总数和本人四项统计，再用一次联表读取当前页活动与报名。两个查询位于同一个只读 `REPEATABLE_READ` 事务，第一次一致性读取建立快照；每个请求只取一次 UTC 微秒时刻计算活动是否开始。分页按报名 `updated_at DESC, id DESC` 稳定排序。筛选只影响列表和 `total`，四项统计始终覆盖本人全部记录，签到是有效报名的子集。

**讲清取舍：** 旧数组保留字段与排序，内部由 1+N 次改为一次联表；新分页为两次业务数据 SELECT，不包含认证读取。候补人数仍有相关 COUNT 子查询，排序与 OFFSET 也有成本，因此不能称底层工作恒定或已经提高吞吐。不同请求各建自己的快照，刷新可能看到新的提交。本人接口只返回签到时间，不暴露签到管理员。

| 阅读入口 | 在代码或证据中找什么 |
| --- | --- |
| [MyRegistrationsPage](../frontend/src/pages/MyRegistrationsPage.tsx)、[个人查询 URL](../frontend/src/myRegistrationQuery.ts)、[统一 HTTP 客户端](../frontend/src/api.ts) | URL 条件、全量统计、越界修正、真实刷新与请求取消 |
| [ActivityController](../backend/src/main/java/com/example/gather/api/ActivityController.java)、[RegistrationService](../backend/src/main/java/com/example/gather/service/RegistrationService.java)、[RegistrationMapper](../backend/src/main/java/com/example/gather/mapper/RegistrationMapper.java) | 当前身份、`searchMine/mine`、`mineTotals` 与联表 SQL、报名 ID 与活动 ID |
| [MyRegistrationSearchIntegrationTest](../backend/src/test/java/com/example/gather/MyRegistrationSearchIntegrationTest.java) | 两次读取间提交取消/签到、单次时钟、旧 1/新 2 次 SELECT、实际 EXPLAIN、只读与本人权限 |
| [个人请求回归](../frontend/tests/myregistrations.test.mjs)、[真实浏览器用例](../e2e/myregistrations.spec.ts)、[我的报名指南](my-registrations-guide.md) | URL/返回/越界、同账号重登后的旧成功与错误、查询证据的范围 |

已有证据使用 MySQL 8.4.11、13 条本人记录：捕获旧数组 1 次、新分页 2 次业务数据 SELECT，并查看实际执行计划。没有测量这个接口的延迟或吞吐收益。

当前已登录请求另有一次凭据版本 SELECT，在进入业务事务前执行。解释查询数量时分别计算认证读取和业务读取，不把它们说成同一个快照。

## 技术卡四：备份文件如何证明能恢复

**从具体问题开始：** 生成 SQL 文件只能证明导出了文件，不能证明结构、数据、图片和应用恢复后可用。本项目在原库保持只读的窗口内导出六张业务表及 Flyway 历史，并在独立 MySQL 实例的新空库中恢复；恢复账号限定目标库，不给全局权限。

**解释实现：** 导出前核对回环地址、数据库 UUID、V10 迁移及 InnoDB，操作者须保证窗口内无写入和 DDL；前后比较结构与全字段摘要，摘要变化就不发布为成功备份。两次摘要与 mysqldump 使用独立读取，不能声称共用一个快照或保证并发在线备份。包内保留 SQL、结构/数据摘要及迁移证据。恢复核对目标身份、空库与授权边界，再验证全部表、行内容、封面 BLOB 摘要、迁移及约束，最后启动专属后端，真实浏览器登录、查看封面、报名和取消。失败保留现场，不清空库重试。

**讲清证据：** 既有本机演练先恢复原始小库，再只在恢复库创建六表及图片样本，二次备份并恢复到另一个新空库，以覆盖原库为空的表和图片。最终记录 `completed/sourcePreserved/cleanupGraceful=true`；这是一次 Windows 本机小样本演练，整体验收 60.723 秒包含应用与浏览器检查，不能作为 SQL 导入耗时、生产 RTO 或任意数据规模的保证。SHA 校验也不能证明文件来源可信。

| 阅读入口 | 在代码或证据中找什么 |
| --- | --- |
| [README 的备份命令](../README.md)、[交付指南](delivery-guide.md) | 启动前置条件、受限输出目录、仅新库恢复与失败处理边界 |
| [备份与恢复实现](../scripts/database-backup.mjs)、[本机恢复演练](../scripts/backup-restore-drill.mjs) | 环境身份核验、一致性导出、目标保护、摘要比对、恢复后应用验收 |
| [实际恢复记录](verification.md#一致性备份与独立恢复演练2026-10-18) | 真实库与样本、失败修复、原库保护、本机演练和 CI 各自验证的范围 |

练习时先阅读命令与保护条件，确认独立目录、端口及目标库后再运行 `npm run verify:restore`。面试展示最终摘要及恢复后截图即可，完整 SQL、密码和会话不作为附件分享。

## 二十分钟模拟面试

先合上文档录音回答，卡住时记下题号再查对应技术卡。下面是练习用时间分配；回答后打开源码和测试核对，不要求背诵逐字答案。

| 时间 | 面试官问题 | 回答必须落到的事实 |
| --- | --- | --- |
| 0–2 分钟 | 这个项目解决什么问题，你实际做了什么？ | 一条用户与管理流程、真实个人职责和 AI 参与范围、本地演示边界 |
| 2–4 分钟 | 点击报名后，请求怎样到数据库？ | 页面、统一客户端、Security、Controller、Service、Mapper；用户 ID 取可信身份 |
| 4–6 分钟 | 两个人抢最后一个名额，为什么不会超额？ | 活动主键锁、锁后检查、事务、唯一约束各自的作用 |
| 6–8 分钟 | 取消后怎么递补？通知插入失败怎么办？ | FIFO 两个排序键、状态/人数/通知一起回滚、重复请求不重复改变人数 |
| 8–10 分钟 | 已有 Cookie，为什么还需要 CSRF？隐藏管理员按钮够吗？ | 自动携带 Cookie、写请求令牌、后端角色校验、明确错误才允许一次重试 |
| 10–12 分钟 | 改密时另一个实例还有旧 Session，怎么办？ | 哈希与版本同次登录读取、条件更新、逐请求版本校验、允许已认证在途操作完成 |
| 12–14 分钟 | 分页与统计为什么不会互相矛盾？SQL 变少就更快吗？ | 一次聚合加一次联表、只读快照、单次时刻、认证读取另计、性能需另测 |
| 14–16 分钟 | 切账号后旧请求才报 401，会不会退出新账号？ | 同账号重登也更新认证代次；成功/错误/清理均核代次、顺序及取消信号 |
| 16–18 分钟 | SQL 文件存在就算备份成功吗？怎样避免覆盖原库？ | 独立实例/空库/受限账号、结构与全字段及图片核对、应用验收、原库摘要不变 |
| 18–20 分钟 | 哪些结论已验证，哪些没有？下一步为什么这样选？ | 分清 Mock/真实 MySQL/浏览器/CI；不宣称公网、生产容量、恢复 SLA；按具体问题选后续工作 |

每题按三级记录：**待补**＝只能复述术语；**能解释**＝能说明条件、失败和取舍并定位源码；**已验证**＝另能给出自己执行的操作/测试及实际结果。第一轮争取十题都能解释，再逐项补验证；做不到的仍写“待自测”。把记录填在下方自检表，不新增学习文件。

## 可编辑简历条目

以下是项目事实模板。投递前填好个人贡献，只保留能自己定位、解释和现场演示的条目；日期、职责及 AI 使用方式由本人核对。

**项目名称：** 集会 Gather｜活动报名平台（个人学习项目，本地演示）

**时间：** 【真实起止时间】

**技术栈：** React、TypeScript、Ant Design、Java 21、Spring Boot、Spring Security、MyBatis、MySQL、Flyway；可选 Spring Session Redis、Docker Compose。

**个人贡献：** 【本人实际完成或核验的模块、设计选择、问题修复】

**协作方式：** 【AI 实际参与的编码、测试或文档环节；本人如何理解、运行和复核】

下面是候选描述，选三到四条即可；需按真实职责把“实现”调整为“参与实现”“复核”或“学习并验证”：

- 实现用户活动搜索、报名、候补、个人记录及管理员取消、签到和 CSV 导出流程，前后端接口与 MySQL 数据连通，支持桌面与手机展示。
- 使用活动主键行锁、`READ_COMMITTED` 事务和唯一约束维护报名人数；候补按更新时间与 ID 递补，真实 MySQL 用例验证 100 个用户竞争 10 个名额、重复操作和异常回滚。
- 使用 Spring Security 的 Cookie Session、CSRF 和服务端角色校验，通过凭据版本使改密后的旧身份失效；可选 Redis 共享 Session，两个真实 Java 实例验证跨实例行为。
- 将本人报名读取改为联表，保留旧数组接口；新分页采用一次聚合和一次当前页查询，在只读快照内返回列表与全量统计，并验证 SQL 次数和执行计划。
- 实现六张业务表及 Flyway 历史的一致性备份与新库恢复保护，以结构、全字段、图片及恢复后应用行为验收，并记录原库保持不变；实际规模与耗时仅引用本机记录。

更短的一句话版本：

> 使用 React、TypeScript 与 Spring Boot 构建活动报名平台，围绕 MySQL 事务与行锁、Session/CSRF 权限和分页快照实现报名候补及管理流程；个人职责为【经核对的实际贡献】。

若被问到 AI，可以据实填写：“我使用 AI 协助【真实环节】，本人负责【真实职责】；我能沿【一个具体请求】解释实现，并通过【自己实际运行过的验证】确认行为。”不要填“全部独立开发”，也不要把仓库历史 CI 说成自己亲手执行的本机验证。

## 个人掌握自检

下面全部从“待自测”开始。能打开代码解释对应条件，并实际完成右侧练习后，再记录日期与结果；阅读过文档不自动算通过。

| 检查项 | 可观察的通过标准 | 本人记录 |
| --- | --- | --- |
| 一条请求 | 从页面请求追到 Security、Controller、Service、Mapper 和响应，指出可信用户 ID 来源 | 待自测 |
| 并发与回滚 | 画出两人争最后一个名额的锁顺序，定位 FIFO 和失败插入回滚断言，解释锁何时释放 | 待自测 |
| 登录与权限 | 说明 Cookie 为什么需要 CSRF、哪些错误可重试、为何旧 401 不能退出新登录 | 待自测 |
| 改密与旧会话 | 用独立测试账号完成双会话改密与重登，指出版本条件更新及旧身份被拒绝的位置 | 待自测 |
| 查询与统计 | 找到两条个人查询，解释同一快照、全量统计、两种 ID 与 SELECT 次数证据的限制 | 待自测 |
| 备份与恢复 | 解释原库与目标保护、逐表/图片/约束验收；自己演练后记录实际摘要，不把历史 CI 当本机恢复 | 待自测 |
| 界面操作 | 本人完成一次报名/候补/取消及详情返回，区分加载、失败、空集合与真实零值 | 待自测 |
| 修改与验证 | 本人先写预期、独立完成一个小改动，选择必要检查，解释失败原因和最终差异 | 待自测 |

建议分三次练习：先不看文档录一段两分钟讲解，再挑一张技术卡沿源码讲清楚，最后做一个小改动。例如把个人报名的空状态说明改得更明确，先写适用条件，运行类型检查/构建并在本机浏览器确认筛选与返回仍正常。更深入的查询或事务修改另开有明确验收的任务，按 [开发约定](../AGENTS.md) 使用相应真实数据库回归。

## 证据怎么引用

本轮按 V10 当前实现更新阅读路径。源码 `c99df8e1c128567d7c67956d039680a762291e13` 对应的 [CI 39100681341](https://github.com/GTASDAW/MYCODE/actions/runs/39100681341) 已有 7/7 成功记录，覆盖前后端、镜像、默认容器和 Redis 双实例等门禁；它没有执行 Windows 本机的完整独立恢复。后者的环境、两次恢复、失败修复及最终摘要单独见 [恢复演练记录](verification.md#一致性备份与独立恢复演练2026-10-18)。这些是已有证据，本次文档整理不重跑业务测试。

技术卡一至三的早期用例和初版材料见 [2026-10-13 验证记录](verification.md#我的报名分页与联表读取迭代2026-10-13)，不能用早期测试数量代表最新全量。改密、限流、封面及加载等结论按 [验证记录](verification.md) 对应章节查。讲性能仅引用 [实际性能报告](performance-report.md) 的固定版本、负载和资源条件，历史 V2 实验不当作当前 V10 性能；项目没有公网地址、支付、报名接口限流或 Redis 高可用实现。个人理解和贡献以自己的自测记录为准。
