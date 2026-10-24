# 自动检查与可复现交付

项目继续只在本机或临时 CI 环境运行；CI 构建和测试不会发布网站。当前实现与验证结果见 [验证记录](verification.md)，实际 CI 结论应查看 [仓库 Actions](https://github.com/GTASDAW/MYCODE/actions)。

当前门禁为 V13，仍为含 activity_favorites 的六张业务表；本轮只增加默认空的 users.avatar_image/avatar_hash 及启用的成对 CHECK。升级前在无写入窗口保留 V12 备份、原列全字段摘要与已有迁移 checksum，升级后核对旧值不变且历史头像全空；用户基线增加完整头像内容与摘要，活动原有报名截止、结束时间、封面及分类继续保护。精确归属、收藏先删、历史 V2 固定列与报告形状的保护保持。

CI 的 `container-images` 矩阵按本次 SHA 分别构建 backend/web，两个镜像各一次，复用独立范围的 GHA 构建缓存。Docker tar 仅通过同次运行的一日 artifact 分发到三个隔离回归任务，加载后核对 revision 标签并 `--no-build` 启动；两个 Redis 后端用同一镜像。npm/Maven 缓存、原单元/真实数据库门禁、浏览器/加载恢复、严格限流、固定资源报名一致性和精确清理保持。浏览器仍单 worker，未为并发修改共享 fixtures；比较阶段时间时计入镜像构建、上传、下载、加载和启动，不能只报后半段变快。

## 备份与恢复边界

`scripts/database-backup.mjs` 提供备份、受限恢复和摘要 API，`scripts/backup-restore-drill.mjs` 负责真实独立环境演练；命令与 Windows 配置见 [README](../README.md#本地备份与恢复演练)。备份范围固定为六业务表及 Flyway，先核对回环地址、显式库名/UUID、MySQL 8.4、V1–V13、InnoDB 与演示账号角色。`mysqldump` 采用单事务、逐行与十六进制 BLOB 输出，不带数据库创建/切换、DROP 或强制跳过错误；密码只通过子进程环境传递，Windows 用 result-file 避免 PowerShell 重编码。依据见 [MySQL 官方备份说明](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html)。

备份前后各用一个只读 RR 快照计算七表全字段摘要（含封面、头像完整内容及 ends_at 与 registration_deadline 的空值/微秒）、结构摘要及迁移校验；mysqldump 属于另一连接，不能与这些快照共用。当前要求整个窗口内无写入/DDL；源摘要改变则不发布包，不把此机制宣称为并发在线备份保证。完整 SQL 与 manifest 最后原子发布，恢复前验证大小/校验和/目录及文件链接，恢复后逐表比对；校验和不能认证恶意改写来源的包，输入仅限可信本地产物。

当前工具只接受 V13 备份包；旧 V12/V11/V10 包应使用匹配版本的工具在独立空库恢复，再由 Flyway 升级，不把不同版本包混入当前门禁。V13 演练另在独立恢复库上传非空头像，核对 256×256 JPEG、完整字节与摘要、本人认证读取及他人/匿名隔离；源库头像和全部业务资料只读保留。

恢复目标只接受新命名空间的空库、显式服务器 UUID 和专属 schema 账号；SHOW GRANTS 仅允许 USAGE 及该库 ALL，不允许其他库、全局权限、角色或 GRANT OPTION。客户端禁用隐式本地配置、交互 shell/source 和 LOCAL INFILE；源或非空目标拒绝，导入/比对失败保留现场。原库与恢复库都不通过 DROP/清空解决失败。备份及演练目录拒绝符号链接/junction，在 Windows 显式设置 ACL，其余系统用受限权限；SQL、数据目录、bootstrap 凭据及原始日志只留忽略目录，不作为 CI 附件。

完整本机演练先从只读 demo 备份到不同 UUID 的新 mysqld，再仅在新库创建覆盖六业务表的样本并恢复到第二空库，最后核对 API、外键/唯一键/人数/结束时间与报名截止约束、结束时间及报名截止联表投影、图片字节及真实桌面/手机。Java 明确绑定各自目标、禁用演示种子、使用独立 Session Cookie，通过新库 SQL 探针读回绑定后才允许 API 写入；结束仅关闭本次 spawn 的进程，原库前后快照及原端口/PID另行核验。CI 跑安全专项与原完整门禁，本轮完整真实恢复结论以本机记录为准。

## 自动检查入口

配置提供自动检查入口；已执行、未执行和首次远程运行结论分别记录在验证记录，不能用配置存在代替执行通过。

`.github/workflows/ci.yml` 使用 Ubuntu runner，默认模式和 Redis 模式分别检查：

| 检查 | 验证内容 | 数据环境 |
| --- | --- | --- |
| `frontend` | 从 lockfile 安装，运行 API/CSRF、改密未知结果/订阅取消/重登状态、账户认证顺序、公开及个人 URL/详情来源安全、个人查询认证代次/取消保护、通知未读顺序、签到/文件响应/过期下载、操作记录 URL/微秒/详情作用域回归、TypeScript 检查和生产构建 | 不写数据库 |
| `backend` | Java 21、Maven Wrapper，运行本人改密/版本撤销/并发 CAS/登录竞态/数据库拒绝、账户、活动生命周期、权限、公开查询快照、个人旧数组兼容/分页/全量统计/签到时间/认证和业务 SELECT 次数及实际计划、通知、签到/CSV、操作记录四类快照/无变化/回滚/权限/微秒/快照读取、真实并发锁顺序和候补 FIFO 测试 | MySQL 8.4 服务容器，独立 `activity_platform_test` |
| `compose-e2e` | 复用当次唯一构建的镜像，验证首次迁移、深链、重启持久化/Session失效；快速CI运行8项smoke，完整CI运行全部376项桌面/手机业务、20项加载及14项严格限流浏览器 | 独立 Compose 项目 `gather-ci`，数据库 `activity_platform_e2e` |
| `redis-session` | 仅完整CI：真实Redis双实例全部生命周期/CSRF/权限/改密晚保存/重启/退出/闲置检查，40项核心及认证浏览器、20项加载、14项共享限流恢复；发布/深度模式可重复全部376项业务浏览器 | 单独 runner，Compose 项目 `gather-redis-ci`，与默认容器任务独立的 MySQL/Redis 卷 |
| `performance` | 仅完整CI：固定资源下两种报名场景、18轮/1800次正式测量、400次写预热、一致性和精确清理 | 单独 runner，Compose 项目 `gather-perf-ci`，数据库 `activity_platform_perf` |

工作流在Push、针对main的PR、手动及每天18:00 UTC（次日北京时间02:00）触发；仅修改 `docs/`、`README.md`、`AGENTS.md` 的Push/PR跳过。前端、后端、两镜像仍并行，容器等待这些门禁和范围判定成功；镜像只构建一次并复用，不新增第二套镜像缓存。Actions继续固定提交SHA，Node.js 24.21.0、MySQL 8.4.11及原digest保持。

## CI分层与发布门禁

`scripts/ci-scope.mjs` 根据Push的before/head或PR的base/head完整差异判定。普通页面、通知及业务实现变更走快速CI，后端仍执行全部真实MySQL测试。安全/配置/Mapper/迁移、账户/改密/报名与活动事务、共享HTTP/认证层、依赖、Docker、工作流、脚本和E2E变更升级完整CI；未知路径、历史缺失、首次Push及异常范围都按完整处理，重命名保留删除源路径。手动/定时始终完整，tag额外强制Redis全量。详细白名单以代码和策略测试为准。

`CI quality gate` 以always运行并校验所选任务结果：快速要求前端、后端、两镜像及Compose成功，Redis/性能应明确跳过；完整要求全部成功。需要的检查失败、取消、跳过或范围判定失败，都不能得到成功总门禁。普通Push/PR可取消被新提交替代的旧运行；手动和定时任务不会被日常Push取消。

Compose和Redis均使用45分钟任务总预算，包含业务浏览器、加载/限流恢复、诊断上传及清理；这是防止完整检查在收尾时触及实测35分钟边界，不代表提速或缩减用例。总门禁仍以job最终结果为准，即使各step已成功，job超时/取消也会拦截。

前端CI额外运行 `npm run check:e2e:types`，通过 `e2e/tsconfig.json` 对全部E2E及两份Playwright配置执行noEmit类型检查；先安装根目录和frontend现有lockfile依赖，不需要数据库或浏览器。待注册fixture保留可空ID，只有登记服务端ID后返回已注册账户；错误收尾数组接受unknown，不用强转或忽略错误绕过检查。

2026-10-21通过GitHub API核对：main未保护，分支protection为404，生效rules/rulesets为空；只有两份测试workflow，没有部署步骤，environments/deployments/releases/repository hooks均为空，Pages为404。本轮不更改远端保护、发布或部署配置，不访问生产；这些证据仅涵盖仓库及GitHub可见配置，不能证明仓库外系统不存在。已有检查名称保留，新增总门禁用于后续保护配置。

发布前必须在Actions手动选定准确发布ref，勾选 `redis_all_e2e`，确认该SHA的完整工作流及Redis全量成功；tag也强制相同全量路径。不能用快速CI、旧SHA或未完成运行作为发布通过，仓库没有新增自动发布。日常完整CI中，默认环境覆盖全部业务，Redis覆盖共享会话、全部改密/迟到401/CSRF恢复与核心报名/通知/权限；需要特定业务与Redis联动诊断时可手动全量，或把对应回归加入 `@redis`。

Playwright保留workers=1：global setup明确拒绝其他值，所有worker共用同步读改写的manifest，多个用例还共享admin/demo及全量列表断言。直接改成2会有manifest丢写、账号状态和数据集合竞争；可靠并行需要独立数据库/账号/manifest，本轮不扩展此架构。`@smoke`、`@redis`只加选择标签，不删除断言、用例或改变超时/重试；CI自动验证集合包含关系、两种设备和全部密码恢复用例。

本地可执行 `npm run test:e2e:smoke`、`npm run test:e2e:redis`，不加筛选的 `npm run test:e2e`继续执行全部业务。认证限流及生产加载保持独立配置，保留两模式检查。工具/浏览器安装整步实测约17–24秒，远小于浏览器主体；未单独测量下载/系统依赖时间，未新增浏览器缓存或宣称缓存收益。原npm/Maven/BuildKit缓存保持。

### 依赖更新与增量安全审查

`.github/dependabot.yml` 覆盖backend Maven、根目录和frontend两处npm、GitHub Actions、两个Dockerfile及根目录/`.github`的Compose配置。每周北京时间04:00分散到周一至周四检查，每个配置项最多一个普通版本更新PR（不是全仓总上限，安全更新另有GitHub限制）。npm/Maven/Actions的minor、patch分组，major独立PR；安全修复另组，不用忽略major的规则屏蔽安全修复。容器摘要/标签更新统一人工审核，并核对Dockerfile、Compose、工作流和本地脚本中的关联引用，不保证跨生态自动同步。依赖PR继续触发原完整CI，不减弱门禁，也不自动合并。

GitHub仓库已启用Dependabot alerts、依赖图及自动安全修复PR；版本更新由配置驱动。没有安装本机服务、升级业务依赖或启用Renovate、CodeQL、Trivy、额外MCP/Skills。

独立 `Dependency review` 工作流使用固定SHA的 `actions/dependency-review-action` v5.0.0，在面向main的PR检查base/head依赖增量；高危或严重漏洞使检查失败，范围包含runtime、development和unknown。只有contents读取权限，不写PR评论；尚未定义许可证策略，因此不做许可证阻断。它不运行Maven/npm构建、不启动数据库，不替代已有业务CI或整仓漏洞扫描。覆盖取决于GitHub依赖图；本轮未额外引入Maven传递依赖/BOM的自动submission，不宣称已覆盖全部传递依赖。

手动验证在Actions选择 `Dependency review`，输入本仓库两个完整40位commit SHA作为 `base_ref/head_ref`；输入先校验为真实commit，缺失或非法值失败，不静默替换为当前SHA。相同SHA的空增量只验证接通，不证明历史依赖无漏洞。普通Push不额外运行这个工作流。

2026-10-24再次核对main仍未保护，仓库自动合并为关闭；本轮未修改分支规则。检查会报告风险，但尚非GitHub强制合并门禁，直接Push main也不经过PR检查。发布仍须按前述准确SHA完整CI规定执行。

### 优化前的真实耗时与预期

[参考运行39533454095](https://github.com/GTASDAW/MYCODE/actions/runs/39533454095) 七项成功；每个job实际起止为下表，不包含其依赖等待：

| Job | 实测耗时 | 主要耗时 |
| --- | --- | --- |
| 前端 | 23秒 | 测试、构建和脚本检查 |
| MySQL后端 | 2分46秒 | 数据库初始化26秒；Maven验证133秒 |
| web/backend镜像 | 16秒/17秒 | 已有BuildKit缓存和同run复用 |
| Compose | 34分41秒 | 全量浏览器27分；加载45秒；严格限流5分18秒 |
| Redis | 36分54秒 | 生命周期89秒；全量浏览器27分28秒；加载41秒；严格限流5分55秒 |
| 固定负载 | 1分40秒 | 独立环境24秒；准备/测量/清理55秒 |

默认容器的工具/浏览器安装整步22秒、镜像下载/加载3+5秒、起栈24秒、迁移/深链/重启22秒；Redis对应21秒、4+9秒、24秒。它们与后端独立MySQL初始化26秒分别计时，不能把这些准备成本全部归为浏览器下载。

参考关键路径为Maven完成→Redis任务，依赖完成到开跑仅3秒；总体约39分47秒。另两次成功运行39437804576/39389787819分别35分16秒/37分12秒，瓶颈在Compose/Redis间变化；前端/镜像不是主瓶颈。Maven最慢类为PasswordChange 37.27秒、AuthRateLimit 15.63秒、CheckIn 14.29秒、Notification 13.41秒，保留全部真实数据库断言及现有串行配置。

参考两模式各执行相同356项业务浏览器。复制活动文件在Compose用例报告合计158.5秒，密码125秒、分类118.3秒、签到105.2秒；最长单例约16.6秒，多数成本是大量串行用例累计，未发现据此可任意缩短的等待。普通CI保留8项，完整默认356+Redis40，较原356+356减少316次重复业务用例执行（44.4%），被减少的业务仍在默认环境全量覆盖。两模式限流/加载有不同存储与代理配置，继续各自验证；发布Redis全量路径也保留。

**预计而非云端实测**：普通快速CI约5–7分钟，前端先在约半分钟反馈、MySQL约3分钟反馈；完整默认约32–38分钟，发布/深度双全量约35–45分钟。参考Redis选中40例的逐例报告合计约246秒、smoke8例约49秒，均是旧运行中四舍五入的用例时间之和，不是新job墙钟。本机smoke约78秒也不等于云端容器耗时。排队、冷缓存和runner波动另计；当Compose原本就是关键路径时，减少Redis重复执行不会等比例缩短完整工作流。

版本对照由独立的 `.github/workflows/query-comparison.yml` 提供，只接受 `workflow_dispatch` 手工触发。它不是常规 `ci.yml` 的第六个推送检查，避免后续功能修改不断对固定旧版本重新实验。

后端检查在 `backend` 目录用 `sh mvnw -B verify`，避免 Windows 工作区的可执行位影响 Linux runner。浏览器测试使用 Chromium；普通业务失败保留截图、trace 和 HTML 报告。账户、活动生命周期、活动发现、个人报名、通知、签到导出和操作记录场景关闭 trace，避免保存请求体、Cookie、文件内容或 DOM 快照；保留密码输入已遮蔽的页面截图，配合状态断言和服务端请求编号定位问题。容器日志、Maven Surefire 报告和冒烟结果放入 CI 附件，不进入 Git。

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

账户流程另外验证 A 的匿名 CSRF 能向 B 注册、注册不自动登录、两独立 Session 在 A/B 读取修改后的昵称、伪造他人身份无效，以及实例重启、只注销当前会话和重新登录。完整浏览器回归包含注册 → 登录 → 报名 → 修改昵称 → 重登，并覆盖表单/接口失败与账号切换后的迟到读取、保存响应；实际完成数量以 [验证记录](verification.md) 为准。

活动生命周期另有跨 A/B 的报名与组织者取消竞态：不同实例仍竞争同一 MySQL 活动行锁，完成后核对取消原因、人数 0、全部报名已取消及重复取消首次信息不变。完整浏览器流程覆盖发布、编辑、有效报名/候补、取消和历史展示；脚本提供这些验证，实际是否通过仍看 [验证记录](verification.md)。

活动发现另验证 A/B 与 Nginx 的公开分页、筛选集合统计和当前用户报名状态，匿名查询即使附带 `userId` 也不能取得他人状态。两种模式的完整浏览器回归包含真实 12/1 条分页、URL 刷新与历史导航、详情登录/返回、报名后的统计刷新、越界修正、失败重试和迟到读取；临时活动继续按准确 manifest 清理。合同与学习路径见 [活动发现指南](activity-discovery.md)，执行结果仍以验证记录为准。

通知通过同一 MySQL 在 A/B 与 Nginx 读取，验证真实递补的私有消息、标读 CSRF 与他人 ID 拒绝、跨实例重复标读保留首次时间、当前参与者取消消息和重启后的历史。完整浏览器流程覆盖通知筛选分页、URL、顶栏未读、刷新/失败和迟到响应，不通过直接造假前端数据替代业务触发。V4、事务和页面职责见 [站内通知指南](notification-guide.md)，最终实际执行结果统一看验证记录。

签到使用 V5 的同一 MySQL 审计字段，跨实例仍先锁活动，保留首次操作人和时间；名单统计、两类筛选与 CSV 从真实数据库读取，Java 重启不清空历史。完整浏览器回归包含确认弹窗、未开始/已取消资格、整场统计、末页修正、超过一页的实际下载与网络/迟到响应。旧 CSV 成功或 401 在换账号后不能下载或退出新会话。字段、20,000 条上限和人工 Excel 查看保护见 [签到与导出指南](checkin-export-guide.md)，各模式实际结果引用验证记录。

两种重启断言都要保留：默认容器模式重启后原 Session 应失效；Redis 模式在会话有效且 Redis 可用时重启 A，原 Cookie 在 A/B 仍应识别同一身份。不能为了 Redis 的新行为删掉默认模式回归。新建空库的双实例启动还要验证管理员和普通用户各一条、演示活动正好三场，不能依赖启动失败后重试来掩盖初始化竞态。

个人报名检查复用 V5 的签到字段，当前环境门禁为 V13：默认容器冒烟核对新分页、全量本人统计、真实签到时间和旧数组字段，重启后重新登录再核对数据库历史；共享模式在 A/B 与 Nginx 分别验证同一 Session 的本人集合、伪造用户参数无效和普通用户不暴露签到操作人。浏览器覆盖四种状态、10/3 分页、URL/详情与登录返回、本人签到、越界校正、失败重试和换账号/同账号重登后的迟到成功与 401。提供这些检查不等于各环境已经执行通过，实际结果统一看 [验证记录](verification.md)。

后端个人读取证据使用专属测试记录捕获数据 SELECT，并对实际 Mapper SQL 执行 `EXPLAIN`；旧数组为一次数据读取，新分页为聚合加联表两次，没有逐条 `ActivityService.get`。关联候补 COUNT 仍是底层工作，未测个人接口时延/吞吐，不能将查询计数或常规报名负载报告写成其性能收益。个人联表迭代本身没有新增迁移、索引、依赖或性能实验合同，细节见 [我的报名指南](my-registrations-guide.md)。

V7 本人改密单独验证真实哈希、并发条件更新、旧哈希登录竞态、原子回滚、缺少版本的旧 Session 和数据库故障。HTTP 查询证据将新增一次凭据版本认证 SELECT 与原业务次数分开。浏览器仅修改准确归属的临时账号，检查双独立登录、未知提交结果、手动重登与迟到成功/401/CSRF；密码不写 manifest、trace、URL 或报告。Redis 两真实实例还使用同一旧 Session 的在途幂等报名：独立创建未来活动并由测试账号报名，以单独事务锁定准确活动主键，COUNT 证据确认 B 的重复报名已过认证并在该行 `FOR UPDATE` 等待；A 改密提交后回滚释放行锁，让 B 返回相同的 200 有效报名及人数，并实际完成 Session 保存，再确认旧 Cookie 在 A/B/轮询入口均不可用。所有路径回滚、关闭连接并收尾请求，不操作共享演示库；保留匿名 Session key，认证与旧 CSRF 已清除。完整合同见 [改密指南](password-change-guide.md)。

管理员操作记录使用 V6：默认容器核对只读深链、CREATE/EDIT/首次 CANCEL、首次 CHECK_IN 与完整字段详情，拒绝匿名与普通用户，并检查重启持久化；Redis 脚本在 A/B/Nginx 比较同一批快照与首次信息。浏览器覆盖真实动作、无变化和重复、长文前后值、URL/分页、失败重试以及旧列表/详情成功和 401 的认证代次保护。脚本同时保留原人数、候补、通知与签到不变量；功能合同和测试入口见 [管理员操作记录指南](audit-log-guide.md)，不在这里提前宣称各模式已通过。

## 性能基线交付

第五个任务 `performance` 使用默认内存 Session 和单个后端，叠加 `.github/compose.perf-ci.yaml`，Java 与 MySQL 容器各限定 2 CPU、1024 MiB。它使用独立库 `activity_platform_perf`、网页回环端口 18098，与浏览器/Redis 任务的 `activity_platform_e2e` 和数据卷分开，不操作本机演示库。

容器启动后，性能脚本先核对实际 Docker 身份与配额，再最多等待 120 秒，确认 `/api/health` 返回 HTTP 200 且状态 `UP`；单次请求最多 2 秒，循环间隔 1 秒。之后另有最多 30 秒的种子提交等待，避免健康已可用但初始化事务尚未完成。就绪与准备不进入报名计时。环境边界与统计回归使用 `npm run test:performance-safety`，实际测量使用 `npm run check:performance`。

当前脚本使用 `gather-signup-v2-write-warmup`：20 次活动列表读取后，再用同/不同活动、并发 1/50 各执行 100 次真实报名，共 400 次写预热，验证状态并逐批清理后开始 18 批正式测量。连接池采样计数明确包含批前、周期和批后。完整成功运行每段应精确清理 1112 场活动、2200 条报名和 100 个临时用户（909 场正式活动、202 场预热活动、1 场绑定探针）；实际删除数量仍以报告为准。

任务保存 `.runtime/ci/performance.json`、`performance.md`、准确临时记录 manifest、Java 版本与容器日志，附件名为 `signup-performance-baseline`。每轮清理自己的操作记录、通知、报名与活动并恢复相同准备基线，最后清理合成用户与绑定探测；当前 V13 活动准备每个新活动产生一条 `CREATE`，报名测量阶段核对仍为初始快照，不得新增其他管理动作。已登录测量请求也执行凭据版本读取，不能把 V6 历史性能数字说成本轮结果。实际结果以报告为准，不提前宣称性能提升。[性能评测](performance-report.md) 保留 2026-10-08 v1 的读预热历史结果；当前 v2 方法与计时边界见 [查询优化复盘](query-optimization-review.md)。两者不混为同一套数字，不把 CI 构建或测量当作公网发布。

## 锁定查询版本对照

在 Actions 手工触发 `.github/workflows/query-comparison.yml` 的 `query-comparison` 任务，在历史 V2 合同兼容的源码中，从固定旧提交和候选提交构建后端，在同一 runner 按 A1 → B1 → B2 → A2 执行 `scripts/compare-signup.sh`。MySQL 容器、数据卷和 Nginx 保持在同一隔离项目；每段重建目标 JVM 并重启 Nginx 刷新 DNS。镜像源码标签和实际 JAR 指纹核对真实版本，数据库身份、资源与唯一探针验证在各段继续执行。

这份历史实验的候选基准为 `d781648d7d9036b653a80e3082b609358a59df35`。`compare-signup.sh` 对迁移目录、`ActivityMapper` 与 `RegistrationService` 检查差异；V3 取消字段、V4 通知表/事务、V5 签到字段、V6 操作记录、V7 凭据版本及 V8 活动分类及 V9 收藏表均不符合历史合同，启动实验前会拒绝。需要复现历史结果时在独立干净 checkout 检出该提交，并按该提交的工作流与依赖执行；新业务的对照需要另建实验合同。历史 phase 只查询原三表，不读取通知、签到字段、操作记录、凭据版本、分类或收藏，原报告合同保持；常规 CI 性能任务测当前 V9 单版本 18 批，不与旧版本混跑。

每段先用同/不同活动、并发 1/50 各 100 次执行 400 次写预热，再运行原有 18 批、1800 次正式报名。四段合计 1600 次独立预热、72 批和 7200 次正式请求；全部按归属清理，不让预热或前一轮改变后续固定数据基线。准备与预热排除正式计时，失败区块不能被分析脚本忽略。

`scripts/performance-compare.mjs` 核对四段原始 JSON 后输出汇总。分段产物在 `.runtime/ci/comparison/{A1,B1,B2,A2}/performance.{json,md}`，汇总在 `.runtime/ci/comparison/comparison.{json,md}`；CI 附件名为 `signup-query-comparison`。参数以工作流该任务为准，代码事实、执行计划、统计口径与结论见 [查询优化复盘](query-optimization-review.md)。2026-10-08 历史基线仍单独保留，不与新任务不同主机的数字直接比较。

## 测试数据清理

前端加载专项使用独立的生产浏览器配置，不加载常规测试的 SQL fixture 初始化。默认及 Redis CI 从实际运行的 Nginx 容器复制内部构建图，核对服务入口资源与图一致，再验证拆包、资源头、缺失资源、慢加载和手动恢复；这些证据元数据不经网页公开提供。原业务浏览器与严格限流阶段继续独立运行，结果见 [验证记录](verification.md) 和 [加载指南](frontend-loading-guide.md)。

签到分析本身只增加只读检查，当前运行门禁为 V13。默认容器对独立已开始活动核对签到前后统计、全量比例、空页、权限及重启；共享模式在 A/B/Nginx 使用相同日期范围核对同一数据，比较时保留每次不同的 `asOf`。真实浏览器检查日期边界、URL、加权比例、名单返回、失败重试及换账号/同账号重登后的迟到成功和错误。检查存在不代表已执行成功，实际结果见 [验证记录](verification.md)。

- Java 测试只删除自己创建并记录的操作记录、通知、报名、活动和用户 ID；数据库连接必须是独立测试库，不能指定生产数据库。
- 浏览器回归记录本次运行创建的活动和账户，结束时先核对全部归属及外部引用，再在同一事务内按“本轮活动操作记录 → 通知 → 报名 → 活动 → 用户”清理。成功和失败的测试都进入清理，清理失败会导致检查失败，不用空 `catch` 隐藏。
- 浏览器清理通过五个必填变量 `E2E_DB_HOST`、`E2E_DB_PORT`、`E2E_DB_NAME`、`E2E_DB_USERNAME`、`E2E_DB_PASSWORD` 取得连接，无静默默认值；只接受回环地址和已知开发/测试库。先核对数据库名、服务器 UUID、Flyway V1–V13、收藏完整列、活动报名截止及结束时间、活动分类、用户凭据版本及头像成对约束/完整内容、取消列、通知列、签到列、操作记录完整列和演示身份，再用带唯一标记的探测活动确认 API 与配置的数据库是同一环境。
- manifest 保存在忽略目录 `.runtime/e2e/<run-uuid>.json`，记录数据库身份和本次活动 ID、准确标题、唯一 description 标记，不记录密码、Cookie 或 Token。创建响应的断言失败时，清理可以凭预先记录的准确标题和唯一标记定位本次记录，不按前缀或 ID 范围删除。编辑请求前通过 `recordFixtureEditIntent` 持久化准确的允许标题/介绍版本，各版本保留完整的本轮 UUID 标记；响应丢失也只按这些精确版本恢复。未声明修改或多个版本匹配不同活动会拒绝删除，未编辑的旧 manifest 仍接受原证明。
- 新 `accounts` 字段在注册请求之前保存准确用户名、完整随机标记、固定 `USER` 角色和允许的昵称列表，成功后补充 ID。活动归属、账号当前昵称与角色及账号引用全部核对通过才开始删除；发现用户关联本轮外活动/报名/通知、被本轮外活动记录为 `cancelled_by`、被外部报名记录为 `checked_in_by`、被外部操作记录为 `actor_user_id` 或昵称超出白名单时整个事务回滚。另核对操作记录与报名所属活动，异常跨活动绑定在任何 DELETE 前拒绝。操作记录与通知只能按已验证归属的本轮活动删除；原管理员作本轮活动 actor 合法，预置账号及其他历史保留。响应丢失时按准确用户名找回并重新核对完整证明；没有 `accounts` 的旧 manifest 仍按原活动归属规则工作，当前 V13 环境核验仍必须通过，六表基线中的活动包含报名截止、结束时间、封面摘要及分类，用户包含凭据版本及完整头像/摘要。
- 容器冒烟创建唯一命名活动，核对首次迁移和重启后的记录，随后精确删除自己的临时记录，不删除预置演示活动。
- CI 在结束阶段保存需要的诊断材料并关闭自己启动的 Compose 项目；只有 CI 本次新建的隔离卷可以销毁。手工运行的常规演示库不适用 CI 清空操作。

需要重试某次清理时，保留原 manifest，使用同一组数据库环境变量：

```powershell
npm run cleanup:e2e -- .runtime/e2e/<run-uuid>.json
```

服务器 UUID、连接目标或活动/账号准确身份不一致时拒绝清理；全部身份验证通过后才执行删除，异常会回滚整个清理事务。删除前先把核对过的活动和用户 ID 写入 manifest，数据库已经提交但进程尚未写入完成结果时，仍可安全恢复。已完成 manifest 保留清理数量供审阅，同一 manifest 重试幂等。预置账号、手工注册账号及本轮之外的记录保持不变。

Windows 文件观察程序短暂占用 manifest 时，原子替换仅对 `EPERM`、`EACCES` 作有界重试，总等待最多 800 ms；永久拒绝仍报告失败，保留临时文件，不先删除目标文件。Linux 和其他错误不会借此静默重试。

## 首次迁移、重启与失败排查

容器冒烟只接受 `gather-ci`、`activity_platform_e2e`、网页回环端口 18088 和数据库回环端口 33306。先核对实际 Docker 标签、配置与端口，等待 `/api/health`、Flyway V1–V13、活动分类、用户凭据版本和种子事务提交，再用 UUID SQL 探针经公共详情绑定 API 与数据库；探针精确清理完成后才登录和执行业务写入。静态首页、详情、通知及操作记录深链、匿名分页与全筛选统计、报名、编辑、取消筛选、私有通知与首次标读、签到及 CSV、操作记录快照与只读详情、重启持久化分别验证。已经开始的签到测试记录只在经过核验的独立环境中按准确归属创建，不改动预置活动的开始时间。

默认模式重启后端后，同一活动、报名、通知、首次已读时间、签到与管理员操作记录应仍在数据库中；旧登录 Session 应返回未登录，重新登录后恢复操作。Redis 模式另行验证共享会话保留。数据库保留与登录保留是两项不同检查，结论必须注明模式。

| 失败位置 | 优先查看 |
| --- | --- |
| 前端安装、构建或 API 回归 | lockfile、Node.js 版本、该任务日志 |
| 后端启动或测试连接 | MySQL 健康检查、`TEST_DB_URL`、账号权限、Surefire 报告 |
| 容器构建 | backend / web 构建日志、Maven 下载、npm 安装；不能用跳过断言解决构建问题 |
| 页面请求 502 或健康超时 | 后端启动日志和 Flyway 日志，确认数据库健康与后端就绪 |
| Redis 模式健康失败或跨实例身份不一致 | Redis 健康日志、连接密码、两实例的 profile/命名空间/闲置时限、会话序列化错误；默认模式不应依赖 Redis |
| 浏览器流程 | Playwright HTML、失败截图和 trace，按请求路径检查权限、CSRF、页面状态 |
| 清理失败 | 精确活动 manifest、数据库身份和连接信息；保留记录并处理根因，不扩大删除范围 |

本地演示按 [五分钟演示指南](demo-guide.md) 进行。架构图复用 [架构与请求流程](architecture.md)，并发和候补递补的设计依据见 [并发报名复盘](concurrency-review.md)。
