# 请求追踪与运行指标

管理员打开 `/admin/monitoring` 查看当前实例的真实请求统计、活动记录获取耗时和 Hikari 连接池快照。页面初次读取一次，点击“刷新指标”再次读取，没有轮询。`GET /api/admin/monitoring` 由后端校验 `ADMIN` 权限；普通用户页面不发起管理数据请求。

## 一次请求怎样定位

进入 Java 的每个 `/api` 请求都会生成新的 UUID，通过响应头 `X-Request-Id` 返回，并在处理期间放入 request attribute 和 MDC。服务端不沿用客户端传入的同名请求头，完成或失败后恢复原 MDC，避免线程复用让下一次请求带上前一个请求的标识。

处理顺序是请求观察 Filter → Session → Spring Security → Controller/Service → Filter 完成记录，因此计时包含会话与权限处理。活动报名的事务与 SQL 不因监控而改变，默认内存 Session 和可选 Redis Session 使用同一套请求追踪。

排查流程：

1. 从浏览器网络面板找到失败请求，记录状态、时间和 `X-Request-Id`。服务端 5xx 提示显示可复制的“问题编号”；权限或业务 4xx 保留原提示。
2. 在本项目日志中按完整标识查找。Windows 启动脚本的后端输出为 `.runtime/backend.out.log`：

   ```powershell
   rg -F '<request-id>' .runtime/backend.out.log
   ```

3. 对照 `http_request` 记录中的方法、路径模板、状态和耗时，以及同标识的 `api_failure` 类型与首个代码位置，定位调用路径后再修复。
4. 容器环境查看本项目 `backend` 日志；Redis overlay 还要查看 `backend2`。在 Nginx 入口，请求标识属于实际响应的 Java 实例。

Nginx 自己生成的网关错误或请求未到 Java 时，可以没有 Java 请求标识。错误 JSON 继续使用现有 `code`、`message`，不把堆栈返回给页面。

## 结构化日志的字段与边界

后端控制台采用 Logstash JSON 格式。自定义请求日志包含固定事件、请求 UUID、有限方法名、路径模板、状态和 `durationMs`；失败记录仅包含异常类名及首个代码位置，不向日志方法传入完整 Throwable。

| 字段 | 意义 |
| --- | --- |
| `event=http_request` | 该 Java 请求已完成或发生处理异常 |
| `requestId` | 本次服务端生成的 UUID，用于关联请求和错误 |
| `method`、`route` | 有限方法与路径模板，例如 `/api/activities/{id}/registration` |
| `status`、`durationMs` | 请求记录的状态及服务端计时 |
| `event=api_failure`、`exceptionType`、`frame` | 严重失败的类型及首个代码位置 |

自定义日志不记录 Cookie、CSRF、密码、请求体、查询参数、原始 URI 或异常 message/cause。未知路径归为 `/UNKNOWN`，未知方法归为 `OTHER`。指标标签只使用方法、路径模板和状态；UUID、用户 ID、活动 ID 不进入指标标签，避免每次请求形成一个新时间序列。

`/api/health` 和 `/api/admin/monitoring` 仍可追踪请求，但不计入本轮的 HTTP Timer，避免健康探测或刷新指标本身抬高请求数。没有公开开放 `/api/metrics`、Prometheus 或外部日志平台。

## 怎样读监控页面

接口标明 `scope=CURRENT_JVM`、`instanceId`、启动/采样时间。所有累计值只属于本次 Java 实例，重启后重置；Redis 共享登录不会共享这些内存指标。多实例 Nginx 轮询下，刷新可能读取另一个实例，先核对实例编号再比较。

| 页面或接口字段 | 统计口径 |
| --- | --- |
| 请求总数 `totalRequests` | 本实例启动以来已记录的 API 请求，排除健康和监控读取 |
| 平均耗时 `averageDurationMs` | 同一累计请求集合的加权平均服务端耗时 |
| 5xx 错误率 `serverErrorRate` | 累计 5xx 数除以累计请求数，接口返回 0–1，页面显示百分比 |
| 4xx 请求数 `clientErrors` | 包括未登录、无权限、CSRF 和业务校验拒绝，不能一律算作系统故障 |
| `routes` | 按方法、路径模板、状态分组，展示累计请求数和平均耗时 |
| 路由 `p95DurationMs` / `maxDurationMs` | 300 秒 Micrometer 旋转窗口的近似 P95 与最大值，无有效窗口样本为 `null`，页面显示 `—` |
| `registrationLock` | 报名/取消中 `SELECT ... FOR UPDATE` 的查询执行与行锁等待合计；累计次数/平均值和同一窗口的 P95/最大值 |
| `databasePool.active/idle/pending/max` | 本实例采样瞬间的使用中、空闲、等待连接线程和配置上限；暂不可用为 `null` |

窗口会旋转，累计请求数与平均值不会随窗口清空。它不是严格滑动窗口中的原始样本排序，不能把各路由或各实例的 P95 相加、平均后称为全站 P95；本接口没有提供集群汇总或全局分位数。

活动记录获取计时从调用 Mapper 到返回或异常，含 SQL 执行、网络和数据库行锁等待。它不是 MySQL 纯锁等待，也不是完整事务耗时。连接池的 `pending` 表示等待取得连接，并不是等待活动行锁。

监控读取只访问当前 Timer 与连接池属性，不重置指标，不主动扫描业务表。页面处理加载、空数据、读取失败与无权限；采样时间按北京时间展示，接口时间保持 UTC。

## 学习与验证

从 `RequestObservationFilter` 看请求标识、异常路径和 MDC 恢复；从 `RequestRoute` 看有限路由模板；从 `MonitoringService` 看累计值、近似窗口、连接池快照和活动记录计时；最后读管理员页面如何把同一接口数据呈现出来。

验证应覆盖成功、权限拒绝、CSRF 失败、未知路由、异常和 MDC 清理；请求标识与日志对应，敏感内容不出现在自定义日志；连续监控读取不改变 HTTP 统计，重启与窗口失效的口径准确。真实执行结果见 [验证记录](verification.md)。

固定负载的客户端精确分位数、并发场景和连接池采样限制见 [性能评测报告](performance-report.md)。运行指标帮助定位问题，不能独立证明系统吞吐量或某个性能瓶颈。
