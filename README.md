# 集会 Gather · 活动报名平台

[![CI](https://github.com/GTASDAW/MYCODE/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/GTASDAW/MYCODE/actions/workflows/ci.yml)

一个可以实际运行、演示和解释的全栈项目：管理员查看概览、搜索管理活动、发布、编辑和取消活动并查看报名名单，用户自主注册、登录、修改昵称，报名、进入候补、取消报名和查看历史记录。前端的数据来自 Java 接口和 MySQL，报名名额、候补递补与活动取消由数据库事务保证。

## 技术栈

React + TypeScript + Vite + Ant Design + React Router；Java 21 + Spring Boot 4.1.1 + Spring Security；MyBatis Spring Boot Starter 4.0.0（这是 Starter 的版本，不是 MyBatis 核心版本）；MySQL 8.4、Flyway、Maven Wrapper、Docker Compose。可选的 `redis` profile 使用 Spring Session Redis 提供共享登录。

## 本地启动（Windows）

本项目提供不修改系统 PATH、不注册系统服务的本地运行脚本。首次准备会把 JDK 21 和 MySQL 8.4 下载到忽略目录 `.tools`；数据库文件和日志保存在 `.runtime`。需要可用的 Node.js 24 和网络连接。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-dev.ps1
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。前端开发服务器把 `/api` 代理到 Java 服务的 8080 端口；本地 MySQL 使用 3307 端口，只监听回环地址。

停止本项目启动的进程：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-dev.ps1
```

脚本不会删除数据库。默认模式的后端 Session 保存在内存中，重启 Java 服务后需要重新登录；这组本机脚本不需要 Redis。

## 演示账号

| 身份 | 用户名 | 初始密码 |
| --- | --- | --- |
| 管理员 | `admin` | `Admin123!` |
| 普通用户 | `demo` | `Demo123!` |

管理员可以使用概览、活动管理、发布活动、报名名单和运行指标页面；普通用户能够报名、进入候补、取消和查看个人报名记录。前端参考 Ant Design Pro 的蓝白侧栏布局，手机通过抽屉导航访问页面。首次启动写入演示用户和未来活动，重启时保留已有数据。

活动开始前，管理员可在详情或管理列表编辑标题、介绍和地点，或填写原因取消整场活动；开始时间与名额固定。活动取消后关闭报名、人数归零，有效报名和候补保留为取消历史，用户能查看首次取消原因与时间。操作、并发设计和学习路径见 [活动编辑与取消](docs/activity-lifecycle.md)。

也可以从登录页进入“注册账号”，创建自己的普通用户。注册成功后需要登录；账号菜单中的“个人中心”可以修改昵称，登录名保持固定。昵称修改后当前页面同步更新，其他独立会话在下一次读取当前用户时取得最新资料。接口、安全规则和面试阅读路径见 [用户注册与个人中心](docs/account-guide.md)。

## Docker Compose 部署

安装并启动 Docker 后，在项目根目录运行：

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

打开 [http://localhost:8088](http://localhost:8088)。Nginx 提供前端并转发 `/api`，Java 和 MySQL 只在容器网络内通信；MySQL 数据放在命名卷中。

公网部署前设置 `.env` 中的数据库和演示账号密码，并配置 HTTPS；通过 HTTPS 访问时设置 `SESSION_COOKIE_SECURE=true`。账号密码环境变量只用于首次创建用户，不会在重启时覆盖已经保存的密码。

```powershell
docker compose logs -f backend
docker compose down
```

`docker compose down` 保留数据卷。项目尚未配置云账号或公网域名，当前演示地址为本机地址。

## 可选：Redis 共享登录演示

基础 Compose 仍是单个 Java 实例和内存 Session。需要演示两个后端共享登录时，使用附加配置：

```powershell
docker compose -f compose.yaml -f compose.redis.yaml up --build -d
```

同样访问 [http://127.0.0.1:8088](http://127.0.0.1:8088)。Nginx 轮询两个后端，Session 身份和 CSRF 存入共享 Redis；会话未过期且 Redis 可用时，重启一个后端仍能继续登录。默认闲置时限为 30 分钟，退出会使共享会话失效。

Redis 只用于共享会话，报名、候补和人数继续由 MySQL 事务保证。Redis 密码样例、模式切换、停止命令和验证边界见 [共享 Session 指南](docs/shared-session.md)。网站仍只作本机演示。

## 接口与业务规则

| 接口 | 用途 | 权限 |
| --- | --- | --- |
| `GET /api/auth/csrf` | 获取 CSRF Token | 公开 |
| `POST /api/auth/login` | 表单格式登录 | 公开，但需要 CSRF |
| `POST /api/auth/register` | 创建普通用户，201 返回资料，不自动登录 | 公开，但需要 CSRF |
| `POST /api/auth/logout` | 退出 | 需要 CSRF |
| `GET /api/auth/me` | 从数据库读取当前用户最新资料 | 登录 |
| `PATCH /api/me/profile` | 修改当前用户昵称 | 登录且需要 CSRF |
| `GET /api/activities`、`GET /api/activities/{id}` | 活动列表、详情 | 公开 |
| `GET /api/admin/overview` | 活动与报名概览 | 管理员 |
| `GET /api/admin/monitoring` | 当前实例的请求、耗时和连接池快照 | 管理员 |
| `GET /api/admin/activities` | 搜索、状态筛选、分页管理列表 | 管理员 |
| `GET /api/admin/activities/{id}/registrations` | 分页、按状态查看报名名单 | 管理员 |
| `POST /api/admin/activities` | 创建活动 | 管理员 |
| `PATCH /api/admin/activities/{id}` | 修改未开始活动的标题、介绍和地点 | 管理员 |
| `POST /api/admin/activities/{id}/cancel` | 取消整场活动并保存原因和历史 | 管理员 |
| `POST /api/activities/{id}/registration` | 报名、重新报名或进入候补 | 登录 |
| `DELETE /api/activities/{id}/registration` | 取消报名或退出候补 | 登录 |
| `GET /api/me/registrations` | 我的报名 | 登录 |
| `GET /api/health` | 服务和数据库健康状态 | 公开 |

写操作发送 CSRF 接口返回的请求头；登录和退出后重新获取 Token。角色从服务端登录身份读取，不接受客户端指定用户或角色。

- 同一活动和用户只有一条报名记录，取消后重新报名会复用这条记录。状态为 `ACTIVE`（有效报名）、`WAITING`（候补中）或 `CANCELLED`（已取消）。
- 名额已满时，报名接口仍返回 200，并把当前用户记录置为 `WAITING`；重复进入候补幂等。取消有效报名后，在同一事务中按排队时间最早的一条候补记录递补为 `ACTIVE`；取消候补只退出队列，不触发递补。
- 活动详情和列表返回 `waitingCount`；概览返回 `waitingRegistrations`；管理报名名单支持 `ALL`、`ACTIVE`、`WAITING`、`CANCELLED` 状态筛选。
- 名额和开始时间创建后固定；活动开始后停止报名、用户取消、编辑和首次活动取消。
- 组织者取消活动时，在同一事务中取消全部有效报名与候补、人数归零，保留所有报名 ID；此前已取消的报名历史不变。重复取消保留首次原因、时间与操作人，即使越过原开始时间仍幂等。已取消活动不可恢复，编辑、报名与用户取消返回 `ACTIVITY_CANCELLED`。
- 报名和取消先锁活动记录，再读取报名状态，最后在同一个事务中修改状态和人数。
- 重复报名、重复取消在活动开放期间返回当前结果，不会重复改变人数。
- 时间在接口中使用 UTC，在页面中按北京时间显示。

管理活动列表支持标题或地点的字面子串搜索，以及全部、未开始、可报名、满员、已开始、已取消筛选；报名名单支持全部、已报名、候补中、已取消筛选。管理分页默认每页 10 条，接口最多每页 100 条。概览总活动含取消活动，并单独统计 `cancelledActivities`；其他活动时间状态和剩余名额排除取消活动，有效报名与候补仍按报名表状态统计，详细口径见 [架构与接口说明](docs/architecture.md)。

## 请求追踪与运行指标

进入 Java 的 API 请求返回服务端生成的 `X-Request-Id`，用来关联安全 JSON 日志；5xx 页面提示显示可复制的问题编号。管理员在 `/admin/monitoring` 手动读取当前实例的请求总数、累计平均耗时、5xx 错误率、4xx 数量、按路由统计及数据库连接池快照。

统计只属于当前 Java 进程，重启后重置。路由 P95/最大值是近 5 分钟旋转窗口，健康和监控读取不计入 HTTP Timer；活动记录获取耗时包含 SQL 与行锁等待，不是数据库纯锁等待。范围和排查方式见 [请求追踪与指标说明](docs/observability.md)。

## 验证

先启动本地服务和数据库，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
npm ci
npx playwright install chromium
$env:E2E_DB_HOST = '127.0.0.1'
$env:E2E_DB_PORT = '3307'
$env:E2E_DB_NAME = 'activity_platform'
$env:E2E_DB_USERNAME = 'activity'
$env:E2E_DB_PASSWORD = 'activity_dev_password'
npm run test:e2e
```

后端测试使用独立的 `activity_platform_test` 数据库和真实 MySQL，覆盖事务、权限、CSRF、重复操作、关闭活动，以及 100 个不同用户竞争 10 个名额和跨活动首次报名。管理查询还验证统计、字面搜索、状态与分页；账户测试验证密码哈希、并发重名、可信身份与独立会话的最新昵称。活动生命周期测试控制报名、用户取消、编辑与组织者取消的两种行锁顺序，并检查开始边界、历史、数据库约束和中途异常回滚。浏览器测试覆盖实际页面与前后端连接，包含桌面和手机视口。

如果已经安装 Chrome，可以用系统浏览器运行测试，无须下载 Chromium：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:e2e
```

浏览器测试只在回环地址的开发/测试库创建临时活动和账户，认证失效、迟到响应和候补递补回归也使用这些记录，不修改已有样例活动的报名或预置账号昵称。五个 `E2E_DB_*` 参数必须显式提供，上述值是本机默认样例；如果更换数据库配置，需同步填写。测试结束时，无论断言成功或失败，都核对本次 manifest 的数据库、活动和账户归属，验证全部身份及引用后，在事务内精确清理；清理失败会使检查失败。

manifest 保存在忽略目录 `.runtime/e2e`，不包含凭据。需要重试时，使用同一组数据库环境变量执行 `npm run cleanup:e2e -- .runtime/e2e/<run-uuid>.json`。前端 CSRF 回归测试在 `frontend` 目录运行 `npm test`；清理边界回归在根目录运行 `npm run test:cleanup`。实际执行结果见 [验证记录](docs/verification.md)。

前端生产构建：

```powershell
Set-Location frontend
npm ci
npm run build
```

## 自动检查与交付

GitHub Actions 在推送 `main`、Pull Request 和手工触发时运行前端测试与构建、Java 21 + 真实 MySQL 集成测试、默认 Compose 环境的迁移与重启检查，以及 Redis 双实例共享登录和桌面/手机浏览器检查。两种 Session 模式分别验证，构建和检查不会发布网站。

独立的 `performance` 任务在 `gather-perf-ci`、`activity_platform_perf` 和固定容器资源下执行两种报名场景，共 18 轮正式测量；当前 v2 脚本先执行 20 次读取和 400 次真实写预热，预热单独验证及清理。它记录客户端原始延迟、吞吐量、错误及真实数据库一致性；[性能评测](docs/performance-report.md) 保留首次 v1 历史结果，当前方法见 [查询优化复盘](docs/query-optimization-review.md)。

单独的 `.github/workflows/query-comparison.yml` 通过 `workflow_dispatch` 手工触发，按 A1 → B1 → B2 → A2 在同一隔离主机对照旧、新锁定查询，共 72 批、7200 次正式报名，1600 次写预热另记并清理。常规 `ci.yml` 保持原有五个检查，不在每次推送时重复固定旧版本实验。改动只收窄内部锁定投影，保留活动行锁、事务、候补 FIFO 和真实详情查询；假设、测量边界与本轮结论见 [锁定查询优化复盘](docs/query-optimization-review.md)。

这份历史对照固定 V2 和三列锁定投影，复现应检出 `d781648d7d9036b653a80e3082b609358a59df35`；当前 V3 为取消判断增加第四列，脚本发现迁移、活动 Mapper 或报名事务不同会拒绝沿用旧实验。常规性能任务则在当前 V3 上运行单版 18 批，不把新业务结果写成历史 SQL 优化收益。

查看 [Actions 运行结果](https://github.com/GTASDAW/MYCODE/actions)，失败诊断包含日志、后端报告、浏览器截图与 trace。容器浏览器与 Redis 任务各自使用独立的 `activity_platform_e2e`；性能任务使用 `activity_platform_perf`，均不使用本机演示库。具体环境、复现命令和清理机制见 [交付指南](docs/delivery-guide.md)。本次实际执行结论见 [验证记录](docs/verification.md)。

## 从代码中学习

1. 从 `frontend/src/api.ts` 看页面如何发送 HTTP 请求。
2. 从 `backend/src/main/java/com/example/gather` 的 Controller、Service、Mapper 跟踪请求。
3. 从 `backend/src/main/resources/db/migration` 看三张业务表、唯一约束、V2 候补状态及 V3 活动取消元数据的增量迁移。
4. 用一个报名请求串起 React → HTTP → Spring Security → Service → SQL → MySQL → 页面刷新。

- [四阶段学习指南](docs/learning-guide.md)
- [架构与接口说明](docs/architecture.md)
- [用户注册与个人中心](docs/account-guide.md)
- [活动编辑、取消与历史记录](docs/activity-lifecycle.md)
- [并发报名复盘](docs/concurrency-review.md)
- [五分钟演示与面试讲解](docs/demo-guide.md)
- [自动检查与可复现交付](docs/delivery-guide.md)
- [Redis 共享 Session 与双实例演示](docs/shared-session.md)
- [请求追踪与运行指标](docs/observability.md)
- [可复现报名性能评测](docs/performance-report.md)
- [报名锁定查询优化与版本对照](docs/query-optimization-review.md)
- [验证记录与当前部署边界](docs/verification.md)

当前实现重点是完整业务流程、数据库一致性和可以复现的验证结果。Redis 可选方案用于共享 Session，默认本机启动保持简单；限流、名额缓存和 Redis 高可用未在本轮加入。
