# 登录与注册限流：规则、存储与验证

登录和注册是公开入口，密码校验和密码哈希需要计算资源。本轮在原有 Cookie Session、CSRF 与服务端权限检查上，增加有限次数的尝试窗口。限流只覆盖 `POST /api/auth/login` 和 `POST /api/auth/register`，不改变活动报名、签到或通知事务，也不承担整个网站的流量防护。

## 哪些请求计数

| 入口与计数维度 | 默认次数 | 窗口 |
| --- | --- | --- |
| 登录：同一来源 | 60 | 60 秒 |
| 登录：同一来源与规范提交用户名的组合 | 10 | 60 秒 |
| 注册：同一来源 | 5 | 600 秒 |

Security Filter 位于 CSRF 校验之后、表单认证之前。通过 CSRF 的尝试都计数，包括登录成功、密码错误、注册成功和注册参数错误；CSRF 拒绝不会消费次数。登录同时检查两个桶，全部允许时才消费，任一超限则都不消费。注册过滤器不读取 JSON 正文，原有 Controller 和 Service 继续完成验证与写入。

提交用户名使用与登录查询相同的 `strip()` 和 `toLowerCase(Locale.ROOT)` 规范化。登录查询还核对实际存储的规范用户名，拒绝 MySQL 重音忽略排序规则匹配出来的不同拼写，保留原大小写、空白及既有长账号登录。端点匹配复用 Spring Security 的路径语义，编码形式的正常接口也共用计数。登录成功、刷新令牌、退出或更换 Session 都不会重置来源计数。组合桶包含来源，其他来源的尝试不会直接锁住某个账号；同一来源更换用户名仍受到来源总次数限制。

固定窗口从首个获准请求开始。超限请求不延长窗口，等待秒数为剩余时间向上取整。窗口到期后，下一个获准请求建立新窗口。窗口交界处可以出现两批接近的请求，所以它不是任意滑动区间的速率保证；默认阈值是本地样例配置，需要按实际访问和共享出口情况调整。

## HTTP 与页面反馈

超限响应为 `429`，保留服务端 `X-Request-Id`，同时提供整数秒 `Retry-After`：

```json
{
  "code": "AUTH_RATE_LIMITED",
  "message": "请求过于频繁，请稍后重试",
  "retryAfterSeconds": 8
}
```

`8` 是响应形状示例，不是固定等待时间。限流存储容量耗尽、状态不一致或调用 Redis 失败时，过滤器返回 `503 AUTH_RATE_LIMIT_UNAVAILABLE` 的静态提示，不泄漏原始存储异常，也不切换到另一套计数绕过限制。Redis profile 的 Session 仓库也依赖 Redis；若它在到达限流过滤器之前失败，仍使用原有安全的 500 错误处理，不承诺所有 Redis 故障都返回 503。

统一 HTTP 客户端仅为 `429 + AUTH_RATE_LIMITED` 接受 1–86400 的整数等待秒数；JSON 与 Header 都合法时采用较大的值。非法等待值作为普通错误处理。429 不刷新 CSRF、不自动重试；既有明确 `403 CSRF_INVALID` 的一次重试合同保持。

登录和注册页面保留输入，等待期间仍可编辑，只禁用提交。倒计时根据截止时间计算，后台标签页恢复时重新计算；到期不会自行发送请求。页面离开时清理计时器和取消请求，成功与错误均核对认证代次；迟到的旧 429 不显示在新页面，旧登录响应不更新新身份。登录后的 CSRF 读取同样携带取消信号，刷新版本与 Promise 身份保护全局令牌缓存，旧响应及清理逻辑不会覆盖新令牌。计时器只更新本地文字，没有网络轮询。

## 计数如何保持一致

默认模式使用内存存储。一次同步操作检查、消费全部桶，以单调时钟判断过期；每次尝试先移除到期项。默认最多 10000 个桶，队列与计数表都受容量限制，不能逐出尚未过期的限制来给新请求让路。单个 Java 服务重启后，内存计数重新开始；多个默认实例各自计数，不适合作为共享限流方案。

显式 `redis` profile 使用现有 `StringRedisTemplate`，不新增中间件或依赖。每个命名空间只有 counts HASH 与 expires ZSET 两个键，字段为计数身份的 SHA-256 摘要，存储不保留 IP 和用户名原文。两键使用相同 hash tag。Lua 在一次原子操作中读取 Redis `TIME`、清理过期桶、检查全部限制与容量、消费次数，并将存储到期时间设为最后一个桶的现有截止时间。被拒绝的请求不刷新桶的截止时间。

两个实例必须使用一致的命名空间、阈值、窗口与来源规则。同一命名空间的计数独立于 Spring Session，退出不会清理它。脚本和测试不扫描或清空共享 Redis，也不把摘要键、IP、账号或凭据写入请求日志。请求指标继续使用既有有限路由和状态码，包括 429 与 503。

## 来源与代理边界

服务端显式关闭自动转发头处理，默认采用直连对端地址。`X-Forwarded-For`、`Forwarded` 和客户端自选的 `X-Gather-Client-IP` 不能改变计数来源。

只有 `AUTH_RATE_LIMIT_TRUSTED_PROXY_IPS` 精确列出的直连代理地址，才允许读取单值、合法字面 IP 的专用 `X-Gather-Client-IP`。IPv4/IPv6 规范化不进行 DNS 查询；重复、逗号链或非法值退回直连地址。Vite 与两份 Nginx 配置在转发时覆盖专用头，不沿用浏览器传入值。

可信代理列表默认为空。通过 Vite/Nginx 访问时，默认会把代理对端视为同一来源；共享出口的正常用户也会共用来源次数。需要区分代理后的用户时，应先确认实际代理地址和网络访问边界，再配置其精确 IP。不要把可被客户端直接使用的同一对端随意列为可信代理；容器 IP 在重建后可能变化，当前配置不自动信任整个私网或任意转发链。

## 配置

应用属性统一位于 `app.auth-rate-limit`，Compose 与 `.env.example` 提供相同环境变量：

| 环境变量 | 默认值 |
| --- | --- |
| `AUTH_RATE_LIMIT_LOGIN_SOURCE_LIMIT` | `60` |
| `AUTH_RATE_LIMIT_LOGIN_SOURCE_WINDOW_SECONDS` | `60` |
| `AUTH_RATE_LIMIT_LOGIN_PAIR_LIMIT` | `10` |
| `AUTH_RATE_LIMIT_LOGIN_PAIR_WINDOW_SECONDS` | `60` |
| `AUTH_RATE_LIMIT_REGISTER_SOURCE_LIMIT` | `5` |
| `AUTH_RATE_LIMIT_REGISTER_SOURCE_WINDOW_SECONDS` | `600` |
| `AUTH_RATE_LIMIT_MAX_BUCKETS` | `10000` |
| `AUTH_RATE_LIMIT_NAMESPACE` | `gather:auth-rate-limit` |
| `AUTH_RATE_LIMIT_TRUSTED_PROXY_IPS` | 空，多个精确 IP 用逗号分隔 |

次数必须为 1–100000，窗口为 1–86400 秒，容量为 2–1000000；命名空间仅允许 1–100 位英文字母、数字、冒号、下划线和连字符。非法配置在启动时拒绝。不同应用应采用各自的命名空间，同组实例配置一致。

原有后端和完整浏览器回归会大量复用演示账号，测试环境显式设置较高次数，仍启用限流。严格用例另设低次数和短窗口，验证真实拒绝与恢复；这是两种测试场景，不能用正常回归没有收到 429 来证明限流有效。Redis 严格阶段结束恢复普通阈值，不改变原有 Session 闲置时限。

## 阅读与验证入口

1. 从 [SecurityConfiguration](../backend/src/main/java/com/example/gather/security/SecurityConfiguration.java) 和 [AuthRateLimitFilter](../backend/src/main/java/com/example/gather/security/ratelimit/AuthRateLimitFilter.java) 看过滤器顺序、端点匹配、计数维度和响应。
2. 从 [来源解析](../backend/src/main/java/com/example/gather/security/ratelimit/ClientSource.java)、[内存存储](../backend/src/main/java/com/example/gather/security/ratelimit/MemoryAuthRateLimitStore.java) 与 [Redis 存储](../backend/src/main/java/com/example/gather/security/ratelimit/RedisAuthRateLimitStore.java) 看地址信任、原子性、过期和容量。
3. 从 [统一客户端](../frontend/src/api.ts)、[AuthProvider](../frontend/src/auth.tsx)、[倒计时](../frontend/src/authRateLimit.ts) 与 [页面 Hook](../frontend/src/useAuthRateLimit.ts) 看等待值验证、取消和认证代次。
4. 从 [真实 MySQL 严格回归](../backend/src/test/java/com/example/gather/AuthRateLimitIntegrationTest.java) 看 CSRF、两桶配额、编码路径、数据库别名和并发；从 [内存存储回归](../backend/src/test/java/com/example/gather/security/ratelimit/MemoryAuthRateLimitStoreTest.java) 看边界时刻、拒绝不消费与容量。
5. 从 [客户端 API 回归](../frontend/tests/api.test.mjs) 与 [计时回归](../frontend/tests/auth-rate-limit.test.mjs) 看合法等待值、一次 CSRF 重试、迟到刷新和清理；从 [真实浏览器用例](../e2e/auth-rate-limit.spec.ts) 看保留输入、手动重试及同 SPA 的新会话保护。
6. 从 [两模式严格检查脚本](../scripts/auth-rate-limit-check.mjs) 看环境身份、真实 A/B 并发、短 TTL、受控索引损坏、普通配置恢复和精确清理。实际结果统一记录在 [验证记录](verification.md)，测试代码存在不等于已经通过。

过滤器顺序参考 [Spring Security 架构](https://docs.spring.io/spring-security/reference/servlet/architecture.html)；计数和过期需要共同原子执行的理由见 [Redis INCR 官方说明](https://redis.io/docs/latest/commands/incr/)。本实现使用受容量约束的 HASH/ZSET 脚本，不直接照搬单键示例。
