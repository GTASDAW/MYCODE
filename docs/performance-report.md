# 可复现报名性能评测

2026-10-08 已在隔离 CI 完成 18 轮、1800 次真实 HTTP 报名。全部返回 HTTP 200，人数、候补、服务端计数及精确清理断言通过。结果来自源码提交 `5285067bf76a11dddf8097beacc985c7f5f4c828` 的 [性能任务](https://github.com/GTASDAW/MYCODE/actions/runs/37737597986)，本报告记录测量基线与限制，没有宣称性能优化或生产容量。

本页保留 2026-10-08 **v1** 的历史方法、数字和当时结论：只有 20 次读取预热，测量 1800 次报名，清理 910 场活动、1800 条报名和 100 个用户；当时的 `poolSamples` 计数未包含批后采样。当前脚本已采用 **v2 / `gather-signup-v2-write-warmup`**，增加 400 次独立真实写预热，采样计数包含批前/周期/批后，完整成功运行应清理 1112 场活动、2200 条报名和 100 个临时用户。下文历史表和结果不改写为 v2 数据。

2026-10-09 的 [锁定查询优化对照](query-optimization-review.md) 在同一主机交错运行两个版本，并使用相同 v2 脚本；只在新实验内部作前后比较，不将本页 v1 数字与不同 CI 运行直接算成收益。

## 固定环境与负载

`scripts/performance-check.mjs` 只接受隔离项目 `gather-perf-ci` 和独立库 `activity_platform_perf`，通过回环地址的 Nginx `http://127.0.0.1:18098` 访问真实 Java/MySQL。数据库仅向测试脚本暴露回环端口 33306。基线使用默认内存 Session、单个后端；Java 和 MySQL 容器各配置 2 CPU、1024 MiB，脚本通过 Docker inspect 核对实际配额与连接目标。

报告保存完整应用提交 SHA、Node/Java/MySQL、镜像、主机环境、容器配额和连接池上限。负载生成器、数据库、Nginx 与 Java 共用 CI 主机，测试资源相互影响；此结果不能当作公网延迟、生产 SLA 或独立负载机下的容量上限。

准备 100 个带本轮 UUID 标记的测试用户，使用真实 Cookie Session 和 CSRF。准备与登录最多并发 5 个，均发生在计时前；开始测量前执行 20 次活动列表读取预热。预热不是充分 JIT 稳态保证，三次重复用于显示本次环境的波动。

| 场景 | 每轮数据与请求 | 必须满足的结果 |
| --- | --- | --- |
| `same-activity` | 100 个不同用户报名同一新活动，名额 10 | HTTP 200 共 100 次，10 条 `ACTIVE`、90 条 `WAITING`，活动有效人数 10 |
| `different-activities` | 100 个不同用户各报名一场新活动，每场 1 名额 | HTTP 200 共 100 次，100 条 `ACTIVE`，每场有效人数 1，无候补 |

两个场景分别使用并发 **1、10、50**，每组重复 **3 次**，共 **18 轮、1800 次报名**。每轮创建独立活动，不用同一用户反复报名已经占有名额的活动来制造虚假吞吐量。

## 怎么计时和计算

客户端每个样本从报名 `fetch` 发出，到完整读取并解析 JSON 结束，包含网络、Nginx、Session/Security 和返回传输。仅计时这 100 个报名请求；登录、CSRF 准备、活动创建、预热、数据库断言和清理不在该轮计时内。

| 结果 | 计算与限制 |
| --- | --- |
| 平均耗时 | 本轮 100 个客户端延迟的平均值 |
| P50 / P95 / P99 | 原始样本排序后的 nearest-rank：取 `ceil(p × n) - 1` 下标，不复用服务端近似窗口 |
| 最大耗时 | 本轮客户端样本的最大值 |
| 吞吐量 | 完成本轮的请求数除以该批次墙钟秒数，含并发调度，非单请求延迟的倒数 |
| 业务 4xx | 单独记录校验/权限等拒绝；满员候补返回 200，不算 4xx |
| 系统错误 | 5xx 与网络失败分别记录，系统错误率为两者之和除以本轮请求数 |
| 其他 HTTP 失败 | 非 200、4xx、5xx 的异常结果另外记录，不悄悄当作成功 |

JSON 保留每轮 100 个原始延迟样本及错误/状态分布，Markdown 展示汇总。全部样本参与分位数，不能只选成功或最快请求。验收要求 18 轮的 HTTP、返回状态、真实数据库与服务端计数均一致；失败仍输出报告并使检查失败。

服务端监控计数和客户端测量集合不同：服务端累计统计还包含准备、登录、创建与预热。脚本只对报名路径的累计请求数作前后差，必须恰好增加 100；活动记录获取计数也必须增加 100。该轮查询与锁等待平均值从累计总耗时前后差计算，不拿已经包含其他轮次的服务端窗口 P95 充当本轮分位数。

## 连接池与锁证据

测量期间每 200 ms 读取管理员监控接口，单次采样未完成时不叠加下一次；结束时停止并等待采样，请求失败不能被静默忽略。监控读取不计入 HTTP Timer，但采样仍消耗少量 CPU/HTTP/日志资源。

`sampledPoolPeakActive`、`sampledPoolPeakPending` 是已采样的最大值，是实际峰值的下界：短于采样间隔的尖峰可能漏掉。没有采到等待连接，不能证明从未等待。`registrationLock` 计时是 SELECT 执行与行锁等待合计，不能称为 MySQL 纯锁等待。

同活动与跨活动场景用于区分串行保护同一活动和可并行处理不同活动的表现。只有客户端延迟、服务端耗时和池采样相互支持时才能提出进一步检查方向；不能仅凭一个较大 P95 就断言数据库、CPU 或连接池是瓶颈。

## 环境保护与精确清理

脚本先核对隔离 Compose 标签、实际连接与配额、数据库 UUID、Flyway、种子身份和 API/数据库一致性，再创建测试用户和活动。不操作本机演示库，不更改 Session 模式、连接池或数据库配置来得到更好数字。

本次创建意图和准确 ID 保存在忽略目录 `.runtime/ci/performance-<run-uuid>.manifest.json`，只含临时记录身份，不含 Cookie、Token、密码或密码哈希。每轮结束核对并精确删除本轮活动和报名，恢复准备后的相同数据基线：102 个用户（2 个预置 + 100 个合成）、4 场活动（3 场种子 + 1 场绑定探测）、0 条报名，避免前一轮留下更多报名影响后续场景。

100 个合成用户和绑定探测保留到最后。成功和异常都先结束在途请求，退出自己的会话，再核对活动、用户与所有关联记录归属，在事务内精确删除，最后逐字段确认原有数据不变。清理前持久化已验证的准确清理意图，用于判断提交后断点，不扩大删除范围。

完整成功运行预计创建 909 场负载活动、1 场 API/数据库绑定探测、100 个测试用户和 1800 条报名；实际删除数量以报告为准。归属变动或异常关联会使清理拒绝或回滚，不按 ID 范围、日期或标题前缀删除。

## 复现与实际结果

隔离 CI 的第五个任务 `performance` 使用基础 Compose、`.github/compose.ci.yaml` 和 `.github/compose.perf-ci.yaml`，同时固定 Java 和 MySQL 配额。运行前应保持工作区干净，使完整提交 SHA 与实际构建代码一致；以下 Bash 命令只用于新建的临时隔离项目，密码是 CI 样例：

以下命令在当前 HEAD 上调用 **v2** 脚本，不会复现本页 v1 数字。复现历史方法需固定本页注明的旧源码提交；执行当前方法时，应把新增写预热、采样计数和实际清理数量与 [新复盘](query-optimization-review.md) 对照。

```bash
export COMPOSE_PROJECT_NAME=gather-perf-ci
export MYSQL_DATABASE=activity_platform_perf MYSQL_USER=activity
export MYSQL_PASSWORD=activity_ci_password MYSQL_ROOT_PASSWORD=ci_mysql_root_password
export APP_PORT=18098 SESSION_COOKIE_SECURE=false
export DEMO_ADMIN_PASSWORD='Admin123!' DEMO_USER_PASSWORD='Demo123!'
export PERF_BASE_URL=http://127.0.0.1:18098
export PERF_DB_HOST=127.0.0.1 PERF_DB_PORT=33306 PERF_DB_NAME=activity_platform_perf
export PERF_DB_USERNAME=activity PERF_DB_PASSWORD=activity_ci_password
export PERF_CPU_LIMIT=2 PERF_MEMORY_LIMIT=1024m
export PERF_APP_SHA="$(git rev-parse HEAD)"
mkdir -p .runtime/ci
npm ci
npm run test:performance-safety
docker compose -f compose.yaml -f .github/compose.ci.yaml -f .github/compose.perf-ci.yaml up --build -d --wait --wait-timeout 180
docker compose -f compose.yaml -f .github/compose.ci.yaml -f .github/compose.perf-ci.yaml exec -T backend java -version > .runtime/ci/performance-java-version.log 2>&1
export PERF_JAVA_VERSION="$(head -n 1 .runtime/ci/performance-java-version.log)"
npm run check:performance
docker compose -f compose.yaml -f .github/compose.ci.yaml -f .github/compose.perf-ci.yaml down
```

最后停止命令保留卷，只有 CI 本次新建隔离卷才由 CI 收尾删除。需要看原始产物时，使用 `.runtime/ci/performance.json` 与 `.runtime/ci/performance.md`；它们作为 `signup-performance-baseline` CI 附件保存 7 天，不提交原始报告或 manifest。任务摘要也列出 18 轮结果。

| 检查 | 当前状态 |
| --- | --- |
| 脚本方法与场景 | 12/12 安全、统计和监控合同测试通过 |
| 18 轮客户端测量与真实数据库断言 | 全部通过；1800 次 HTTP 200，业务 4xx、5xx、网络失败均为 0 |
| 环境/资源与精确清理结果 | 实际配额核验通过，每轮恢复固定基线；删除 910 活动、1800 报名、100 合成用户，原始行逐字段保留 |
| 瓶颈与优化前后对比 | 观察到热门活动串行处理及连接排队；本轮建立基线，没有实施 SQL/连接池性能改动，也没有前后提升结论 |

## 首次实测结果（2026-10-08）

实测在北京时间 14:29:09–14:29:46 完成，包含准备、测量、断言和清理。主机为 Linux `6.17.0-1022-azure`，CPU 型号 `AMD EPYC 9V74 80-Core Processor`，实际分配 **4 个逻辑 CPU、约 15.61 GiB 内存**；型号中的 80 核不是本次可用 CPU 数。Java 与 MySQL 各有实际 **2 CPU、1024 MiB** 配额，共享这台主机；Nginx 与 Node 负载生成器没有独立 CPU 配额。

实际版本为 Node `24.21.0`、OpenJDK `21.0.12.1`、MySQL `8.4.11`，默认内存 Session、Hikari 上限 20。每轮使用 100 个不同用户，前后基线固定为 102 用户、4 活动（含身份探针）、0 报名。同活动的九轮每轮均为 10 ACTIVE / 90 WAITING；不同活动的九轮每轮均为 100 ACTIVE。

下表是每组三轮各自结果的最低–最高范围。P95 范围来自三批各 100 个原始客户端样本，**不是合并 300 个样本后的 P95**；查询列仍包括执行与锁等待。连接池列只报告采到的最大值。

| 场景 | 并发 | 吞吐 req/s | 客户端均值 ms | 客户端 P95 ms | 行获取均值 ms | 池 active / pending 采样最大值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 同活动 | 1 | 107.35–131.71 | 7.59–9.31 | 16.47–18.62 | 0.64–0.92 | 1 / 0 |
| 不同活动 | 1 | 158.76–237.01 | 4.22–6.29 | 4.69–8.95 | 0.35–0.52 | 1 / 0 |
| 同活动 | 10 | 253.99–419.43 | 23.06–36.42 | 40.90–93.60 | 18.81–30.09 | 10 / 0 |
| 不同活动 | 10 | 606.42–712.80 | 13.63–16.07 | 23.49–28.44 | 0.85–0.93 | 0 / 0，未取得负载中周期样本 |
| 同活动 | 50 | 237.17–380.60 | 106.41–165.83 | 154.90–233.89 | 43.97–71.84 | 20 / 29 |
| 不同活动 | 50 | 711.91–883.61 | 47.98–64.35 | 81.37–111.84 | 1.39–2.17 | 0 / 0，未取得负载中周期样本 |

同活动并发从 10 增至 50 后，吞吐没有稳定提高，平均和尾延迟上升；50 并发三轮均实际采到连接池占满，等待连接数的采样峰值分别为 29、13、29。这与同一活动必须串行执行、连接暂被等待行锁的事务占用相符，不能据此断言 CPU 饱和，也不能把全部行获取耗时称为纯锁等待。

不同活动在相同并发下的行获取均值显著更低，但并发 10/50 的六批都短于 200 ms，只有批前/批后快照，没有周期性负载中样本。JSON 的 `poolSamples=1` 记录批前加周期采样次数，不包含批后计数；最大值仍比较批后快照。表中的 0/0 不代表负载期间没有占用或等待连接。每批只有 100 请求，50 并发约两波；读预热不保证写路径进入稳态，三轮波动较大，不能将这些数字推广为持续吞吐能力。

调用路径审查还确认 `lockById` 读取的候补 COUNT 与展示字段没有被报名服务使用，最终详情查询会重新读取真实候补数。这是下一项可单独检查的冗余读取，但本次时间数据不能证明它是主要耗时来源。下一次实验应先核对执行计划和锁持有期间 SQL，再收窄内部锁定投影，保留主键行锁、事务及 FIFO 不变量，并在相同资源和负载下做对照；不以增加连接数或取消锁换取表面吞吐。
