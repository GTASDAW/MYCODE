# 集会 Gather · 活动报名平台

一个可以实际运行、演示和解释的全栈项目：管理员查看概览、搜索管理活动、发布活动和查看报名名单，用户报名、进入候补、取消和查看记录。前端的数据来自 Java 接口和 MySQL，报名名额与候补递补由数据库事务保证。

## 技术栈

React + TypeScript + Vite + Ant Design + React Router；Java 21 + Spring Boot 4.1.1 + Spring Security；MyBatis Spring Boot Starter 4.0.0（这是 Starter 的版本，不是 MyBatis 核心版本）；MySQL 8.4、Flyway、Maven Wrapper、Docker Compose。

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

脚本不会删除数据库。后端 Session 保存在内存中，重启 Java 服务后需要重新登录。

## 演示账号

| 身份 | 用户名 | 初始密码 |
| --- | --- | --- |
| 管理员 | `admin` | `Admin123!` |
| 普通用户 | `demo` | `Demo123!` |

管理员可以使用概览、活动管理、发布活动和报名名单四类页面；普通用户能够报名、进入候补、取消和查看个人报名记录。前端参考 Ant Design Pro 的蓝白侧栏布局，手机通过抽屉导航访问页面。首次启动写入演示用户和未来活动，重启时保留已有数据。

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

## 接口与业务规则

| 接口 | 用途 | 权限 |
| --- | --- | --- |
| `GET /api/auth/csrf` | 获取 CSRF Token | 公开 |
| `POST /api/auth/login` | 表单格式登录 | 公开，但需要 CSRF |
| `POST /api/auth/logout` | 退出 | 需要 CSRF |
| `GET /api/auth/me` | 当前用户 | 登录 |
| `GET /api/activities`、`GET /api/activities/{id}` | 活动列表、详情 | 公开 |
| `GET /api/admin/overview` | 活动与报名概览 | 管理员 |
| `GET /api/admin/activities` | 搜索、状态筛选、分页管理列表 | 管理员 |
| `GET /api/admin/activities/{id}/registrations` | 分页、按状态查看报名名单 | 管理员 |
| `POST /api/admin/activities` | 创建活动 | 管理员 |
| `POST /api/activities/{id}/registration` | 报名、重新报名或进入候补 | 登录 |
| `DELETE /api/activities/{id}/registration` | 取消报名或退出候补 | 登录 |
| `GET /api/me/registrations` | 我的报名 | 登录 |
| `GET /api/health` | 服务和数据库健康状态 | 公开 |

写操作发送 CSRF 接口返回的请求头；登录和退出后重新获取 Token。角色从服务端登录身份读取，不接受客户端指定用户或角色。

- 同一活动和用户只有一条报名记录，取消后重新报名会复用这条记录。状态为 `ACTIVE`（有效报名）、`WAITING`（候补中）或 `CANCELLED`（已取消）。
- 名额已满时，报名接口仍返回 200，并把当前用户记录置为 `WAITING`；重复进入候补幂等。取消有效报名后，在同一事务中按排队时间最早的一条候补记录递补为 `ACTIVE`；取消候补只退出队列，不触发递补。
- 活动详情和列表返回 `waitingCount`；概览返回 `waitingRegistrations`；管理报名名单支持 `ALL`、`ACTIVE`、`WAITING`、`CANCELLED` 状态筛选。
- 名额创建后固定；活动开始后停止报名和取消。
- 报名和取消先锁活动记录，再读取报名状态，最后在同一个事务中修改状态和人数。
- 重复报名、重复取消在活动开放期间返回当前结果，不会重复改变人数。
- 时间在接口中使用 UTC，在页面中按北京时间显示。

管理活动列表支持标题或地点的字面子串搜索，以及全部、未开始、可报名、满员、已开始筛选；报名名单支持全部、已报名、候补中、已取消筛选。管理分页默认每页 10 条，接口最多每页 100 条。概览统计包含所有活动的有效报名数和候补记录数，剩余名额只统计尚未开始的活动，详细口径见 [架构与接口说明](docs/architecture.md)。

## 验证

先启动本地服务和数据库，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
npm install
npx playwright install chromium
npm run test:e2e
```

后端测试使用独立的 `activity_platform_test` 数据库和真实 MySQL，覆盖事务、权限、CSRF、重复操作、关闭活动，以及 100 个不同用户竞争 10 个名额和跨活动首次报名。管理查询还验证统计、字面搜索、状态与分页。浏览器测试覆盖实际页面与前后端连接，包含桌面和手机视口。

如果已经安装 Chrome，可以用系统浏览器运行测试，无须下载 Chromium：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:e2e
```

浏览器测试会在本地演示数据库创建以“浏览器验证”开头的临时活动，认证失效、迟到响应和候补递补回归也使用这些临时活动，不修改已有样例活动的报名状态；完成后按明确的测试活动 ID 清理。前端 CSRF 回归测试在 `frontend` 目录运行 `npm test`。实际执行结果见 [验证记录](docs/verification.md)。

前端生产构建：

```powershell
Set-Location frontend
npm ci
npm run build
```

## 从代码中学习

1. 从 `frontend/src/api.ts` 看页面如何发送 HTTP 请求。
2. 从 `backend/src/main/java/com/example/gather` 的 Controller、Service、Mapper 跟踪请求。
3. 从 `backend/src/main/resources/db/migration` 看三张业务表、唯一约束和 V2 对 `WAITING` 状态的增量迁移。
4. 用一个报名请求串起 React → HTTP → Spring Security → Service → SQL → MySQL → 页面刷新。

- [四阶段学习指南](docs/learning-guide.md)
- [架构与接口说明](docs/architecture.md)
- [并发报名复盘](docs/concurrency-review.md)
- [验证记录与当前部署边界](docs/verification.md)

Redis 留待出现缓存、共享 Session 或接口限流需求后再引入。当前实现重点是完整业务流程、数据库一致性和可以复现的验证结果。
