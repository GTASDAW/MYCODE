# 自动检查与可复现交付

项目继续只在本机或临时 CI 环境运行；CI 构建和测试不会发布网站。当前实现与验证结果见 [验证记录](verification.md)，实际 CI 结论应查看 [仓库 Actions](https://github.com/GTASDAW/MYCODE/actions)。

## 自动检查入口

配置提供自动检查入口；已执行、未执行和首次远程运行结论分别记录在验证记录，不能用配置存在代替执行通过。

`.github/workflows/ci.yml` 使用 Ubuntu runner，默认模式和 Redis 模式分别检查：

| 检查 | 验证内容 | 数据环境 |
| --- | --- | --- |
| `frontend` | 从 lockfile 安装，运行前端 API/CSRF 回归、TypeScript 检查和生产构建 | 不写数据库 |
| `backend` | Java 21、Maven Wrapper，运行现有权限、查询、事务、并发和候补 FIFO 集成测试 | MySQL 8.4 服务容器，独立 `activity_platform_test` |
| `compose-e2e` | 实际构建前后端容器，验证首次迁移、页面深链、重启后数据保留与 Session 失效，再运行桌面和手机浏览器回归 | 独立 Compose 项目 `gather-ci`，数据库 `activity_platform_e2e` |
| `redis-session` | 真实 Redis 双实例、跨实例身份/CSRF/权限、重启保留登录、共享退出、闲置失效，再运行完整浏览器回归 | 单独 runner，Compose 项目 `gather-redis-ci`，与默认容器任务独立的 MySQL/Redis 卷 |

工作流在推送 `main`、针对 `main` 的 Pull Request 和手工触发时运行；仅修改 `docs/`、`README.md`、`AGENTS.md` 时跳过，避免重复已经通过的业务检查。容器检查等待前端和后端检查通过。Actions 使用固定提交 SHA，Node.js 使用 24.21.0，MySQL 使用 8.4.11 并固定镜像 digest。

后端检查在 `backend` 目录用 `sh mvnw -B verify`，避免 Windows 工作区的可执行位影响 Linux runner。浏览器测试使用 Chromium；失败时保留测试截图、trace 和 HTML 报告。容器日志、Maven Surefire 报告和冒烟结果放入 CI 附件，不进入 Git。

## 本地复现

Windows 开发环境沿用 README 的安装与启动脚本。前端检查：

```powershell
Set-Location frontend
npm ci
npm test
npm run build
```

后端使用项目自带脚本指定本机 3307 端口的独立测试库：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
```

容器环境需要运行中的 Docker。常规本机演示配置从 `.env.example` 创建 `.env`，执行 `docker compose up --build -d`，访问 `http://127.0.0.1:8088`。`docker compose down` 保留命名卷和数据；需要停机时只操作当前项目，不删除现有数据库或其他项目的卷。

CI 使用 `compose.yaml` 和 `.github/compose.ci.yaml`，两者共同定义隔离项目。CI 网页地址为 `http://127.0.0.1:18088`，供浏览器测试使用；数据库端口 `127.0.0.1:33306` 仅供测试清理连接。CI 数据库、服务和卷均属于 `gather-ci`，与本机开发服务分开。以下 Bash 命令用于一份新的临时 CI 项目，不应用于已有演示数据卷：

```bash
export COMPOSE_PROJECT_NAME=gather-ci
export MYSQL_DATABASE=activity_platform_e2e MYSQL_USER=activity
export MYSQL_PASSWORD=activity_ci_password MYSQL_ROOT_PASSWORD=ci_mysql_root_password
export APP_PORT=18088 SESSION_COOKIE_SECURE=false
export DEMO_ADMIN_PASSWORD='Admin123!' DEMO_USER_PASSWORD='Demo123!'
export E2E_BASE_URL=http://127.0.0.1:18088
export E2E_DB_HOST=127.0.0.1 E2E_DB_PORT=33306 E2E_DB_NAME=activity_platform_e2e
export E2E_DB_USERNAME=activity E2E_DB_PASSWORD=activity_ci_password
export SMOKE_RESTART_BACKEND=1
npm ci
npx playwright install --with-deps chromium
docker compose -f compose.yaml -f .github/compose.ci.yaml config --quiet
docker compose -f compose.yaml -f .github/compose.ci.yaml up --build -d --wait --wait-timeout 180
node scripts/compose-smoke.mjs
npm run test:e2e
docker compose -f compose.yaml -f .github/compose.ci.yaml down
```

最后一条命令保留数据卷。GitHub 临时 runner 的收尾额外删除本次新建隔离卷；不要对已有本机演示环境执行带 `--volumes` 的清空命令。上面的密码仅是临时测试环境样例。

## Redis 双实例交付

基础 `compose.yaml` 与 Windows 脚本保持默认内存 Session。共享方案单独选择 `compose.redis.yaml`，启动、配置和演示步骤见 [共享 Session 指南](shared-session.md)。两个后端共用 MySQL、Redis、命名空间和闲置时限，Nginx 轮询请求，不使用粘滞会话。

Redis CI 同时使用 `.github/compose.ci.yaml` 和 `.github/compose.redis-ci.yaml`，连接测试库 `activity_platform_e2e`，网页入口为 `http://127.0.0.1:19088`。分别核对后端的回环测试地址为 `http://127.0.0.1:19081`、`http://127.0.0.1:19082`；常规演示没有这些直连端口，也不暴露 Redis。

`scripts/redis-session-check.mjs` 在明确的 `gather-redis-ci` 隔离项目中验证跨实例会话。默认闲置时限是 30 分钟；3 秒失效场景会重新配置该项目的两个后端，停止访问后验证失效，再恢复 30 分钟。恢复后从轮询入口执行完整桌面/手机浏览器回归。脚本保留报告并精确清理自己的数据库记录，CI 保存日志后只收尾本次隔离项目。

两种重启断言都要保留：默认容器模式重启后原 Session 应失效；Redis 模式在会话有效且 Redis 可用时重启 A，原 Cookie 在 A/B 仍应识别同一身份。不能为了 Redis 的新行为删掉默认模式回归。新建空库的双实例启动还要验证管理员和普通用户各一条、演示活动正好三场，不能依赖启动失败后重试来掩盖初始化竞态。

## 测试数据清理

- Java 测试只删除自己创建并记录的活动、报名和用户 ID；数据库连接必须是独立测试库，不能指定生产数据库。
- 浏览器回归记录本次运行创建的活动 ID 和准确标题，结束时核对后在事务内先删除对应报名，再删除对应活动。成功和失败的测试都进入清理，清理失败会导致检查失败，不用空 `catch` 隐藏。
- 浏览器清理通过五个必填变量 `E2E_DB_HOST`、`E2E_DB_PORT`、`E2E_DB_NAME`、`E2E_DB_USERNAME`、`E2E_DB_PASSWORD` 取得连接，无静默默认值；只接受回环地址和已知开发/测试库。先核对数据库名、服务器 UUID、Flyway V1/V2 和演示身份，再用带唯一标记的探测活动确认 API 与配置的数据库是同一环境。
- manifest 保存在忽略目录 `.runtime/e2e/<run-uuid>.json`，记录数据库身份和本次活动 ID、准确标题、唯一 description 标记，不记录密码、Cookie 或 Token。创建响应的断言失败时，清理可以凭预先记录的准确标题和唯一标记定位本次记录，不按前缀或 ID 范围删除。
- 容器冒烟创建唯一命名活动，核对首次迁移和重启后的记录，随后精确删除自己的临时记录，不删除预置演示活动。
- CI 在结束阶段保存需要的诊断材料并关闭自己启动的 Compose 项目；只有 CI 本次新建的隔离卷可以销毁。手工运行的常规演示库不适用 CI 清空操作。

需要重试某次清理时，保留原 manifest，使用同一组数据库环境变量：

```powershell
npm run cleanup:e2e -- .runtime/e2e/<run-uuid>.json
```

服务器 UUID、连接目标或活动准确身份不一致时拒绝清理；全部身份验证通过后才执行删除，异常会回滚整个清理事务。删除前先把核对过的 ID 写入 manifest，数据库已经提交但进程尚未写入完成结果时，仍可安全恢复。已完成 manifest 保留清理数量供审阅，同一 manifest 重试幂等。

Windows 文件观察程序短暂占用 manifest 时，原子替换仅对 `EPERM`、`EACCES` 作有界重试，总等待最多 800 ms；永久拒绝仍报告失败，保留临时文件，不先删除目标文件。Linux 和其他错误不会借此静默重试。

## 首次迁移、重启与失败排查

容器冒烟会等待 `/api/health` 成功，再验证 Flyway V1、V2 已执行，静态首页和 `/activities/{id}` 刷新直达可用，真实认证 API 能完成报名与候补。

默认模式重启后端后，同一活动和报名应仍在数据库中；旧登录 Session 应返回未登录，重新登录后恢复操作。Redis 模式另行验证共享会话保留。数据库保留与登录保留是两项不同检查，结论必须注明模式。

| 失败位置 | 优先查看 |
| --- | --- |
| 前端安装、构建或 API 回归 | lockfile、Node.js 版本、该任务日志 |
| 后端启动或测试连接 | MySQL 健康检查、`TEST_DB_URL`、账号权限、Surefire 报告 |
| 容器构建 | backend / web 构建日志、Maven 下载、npm 安装；不能用跳过断言解决构建问题 |
| 页面请求 502 或健康超时 | 后端启动日志和 Flyway 日志，确认数据库健康与后端就绪 |
| Redis 模式健康失败或跨实例身份不一致 | Redis 健康日志、连接密码、两实例的 profile/命名空间/闲置时限、会话序列化错误；默认模式不应依赖 Redis |
| 浏览器流程 | Playwright HTML、失败截图和 trace，按请求路径检查权限、CSRF、页面状态 |
| 清理失败 | 精确活动 manifest、数据库身份和连接信息；保留记录并处理根因，不扩大删除范围 |

面试演示按 [五分钟演示指南](demo-guide.md) 进行。架构图复用 [架构与请求流程](architecture.md)，并发和候补递补的设计依据见 [并发报名复盘](concurrency-review.md)。
