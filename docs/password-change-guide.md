# 本人修改密码与旧会话失效

登录后从“个人中心”的独立卡片修改本人密码。普通用户和管理员使用同一接口，成功后需要重新登录；同账号其他独立登录在下一次业务请求时失效。已经通过认证版本检查的在途操作允许完成，没有跨窗口推送或定时轮询。

## 接口和密码规则

`POST /api/me/password` 接受 JSON `{currentPassword,newPassword}`，需要 Cookie Session 和 CSRF，成功返回 `200 {"success":true}`。用户 ID、角色和旧密码哈希都不从请求取得；附带他人 ID 不改变操作对象。公开用户响应不增加凭据版本或哈希。

原密码从数据库重新读取哈希验证，不能依赖登录后已经清除的 Session 密码。新密码与注册共用规则：8–64 个 UTF-16 代码单元，包含 ASCII 英文字母和数字，UTF-8 不超过 72 字节。不 trim，首尾空格属于密码；新密码不能与当前密码相同。原密码只检查必填和字节上限，避免把新注册规则强加给历史密码。确认值由前端精确比较，不提交给后端。

| HTTP / code | 含义与处理 |
| --- | --- |
| 400 `CURRENT_PASSWORD_INCORRECT` | 原密码不正确，可修改输入后手动重试 |
| 400 `PASSWORD_UNCHANGED` / `VALIDATION_ERROR` | 新旧相同或参数不合规则 |
| 401 `SESSION_REVOKED` / `UNAUTHENTICATED` | 登录失效，重新登录 |
| 403 `CSRF_INVALID` | 统一客户端只刷新并重试一次；其他 403 不重试 |
| 429 `AUTH_RATE_LIMITED` | 保留输入，按等待秒数禁用提交，到期手动重试 |
| 503 `AUTHENTICATION_UNAVAILABLE` | 数据库凭据校验不可用，拒绝进入业务 |
| 503 `AUTH_RATE_LIMIT_UNAVAILABLE` | 限流存储不可用，不绕过计数 |
| 500 `PASSWORD_CHANGE_UNCONFIRMED` | 数据库已提交后清理会话失败，不能宣称回滚 |

接口纳入固定请求日志与指标路径。请求正文、密码、哈希、Cookie 和 Token 均不写入诊断记录。

## 版本为何能撤销旧会话

[V7](../backend/src/main/resources/db/migration/V7__add_user_credential_version.sql) 为 `users` 增加非负 `BIGINT credential_version`，默认 0。登录从同一用户行读取密码哈希和版本，`AppUserDetails` 保存当时版本，仍清除密码凭据。缺少版本的旧 Session 必须重新登录；不能把登录校验后的最新版本补给一个用旧哈希验证的身份。

改密事务使用 `READ_COMMITTED`：普通读取用户、核对身份版本、验证原密码、计算 BCrypt，然后以 `id + credential_version` 为条件原子更新新哈希并将版本加一。BCrypt 期间不持有用户行锁；并发改密只能有一个旧版本成功，失败者不能覆盖胜者。数据库更新或事务提交失败不留下半次更新，提交之后的网络或会话清理失败则不能反推数据库回滚。

业务授权前，`CredentialVersionFilter` 对每个已登录 API 请求额外执行一次仅取版本的 SELECT，不缓存结果。版本不符、用户缺失或旧 Session 缺少版本时清除该会话的认证与 CSRF；受保护接口返回 401，公开活动列表、搜索和详情按匿名继续，个人报名状态为空。数据库校验异常返回安全 503，不放行旧身份。旧身份访问 CSRF 接口也返回 401，当次不新建匿名 Session 或发送 Cookie；下一次明确重新登录或初始化可正常取得匿名令牌，避免旧 CSRF 响应覆盖新登录。

改密提交成功后清除当前认证与旧 CSRF，保留匿名 HTTP Session，直到既有闲置过期。既不原地清空其他已入场请求持有的旧 Context，也不删除 Redis key，让已通过版本检查的在途操作能够完成；即使迟到保存带回旧身份，它仍是旧版本，下一请求必须拒绝。Redis 模式不枚举其他会话。

改密和凭据撤销不改变匿名 Session ID，也不发送删除 `JSESSIONID` 的响应头，防止旧响应晚到时清除新登录的 Cookie；旧 Cookie 本身不再代表有效登录。下一次正常登录仍轮换 Session ID，显式“退出登录”保留物理失效和删除 Cookie 的原合同。

查询次数需要分开计数：认证增加一次版本 SELECT；个人旧数组业务读取仍一次，新分页仍两次，签到分析仍两次。版本读取位于业务快照之外，不宣称跨认证与业务事务是同一个快照，也不由语句数量推导未经测量的性能收益。

## 尝试次数与页面恢复

改密限流在 CSRF、身份版本和授权检查通过后执行，默认同账号 5 次/600 秒、同来源 20 次/600 秒。两个桶共同原子消费，成功、错误密码和参数错误都计数，匿名与无效 CSRF 不计数；超限不消费其他桶、不延长窗口、不自动重试。账号维度来自可信 ID，来源沿用现有精确代理规则。默认内存，Redis profile 共享同一计数存储，配置见 [限流指南](auth-rate-limit.md)。

提交期间防止重复请求。成功、离开页面或身份变化会清空密码；输入不写入 URL、浏览器存储或报告。成功后先使旧认证代次失效并保持表单挂载，读取本次转换专属的新 CSRF，再在同一 React transition 清除用户并带成功提示、用户名和个人中心返回地址跳转登录页，防止通用权限跳转覆盖这些信息。确认成功的 POST 即使随后 CSRF 刷新失败，仍提示密码已更新。

共享 CSRF 读取有独立取消控制器：单个订阅离开只取消自己，其他有效订阅及初始化仍去重；全部离开或认证转换会真正取消 fetch。明确 403 恢复在刷新前后都核对原发送版本，旧身份响应不能跨转换重提写请求。取消只能阻止尚未交付的响应，不能追溯撤销浏览器已经应用的 Cookie，因此仍需服务端旧 CSRF 401 和撤销 Cookie 保护。

网络中断、无效成功响应或服务器错误可能发生在提交之后，页面显示“结果未确认，请重新登录确认”，禁止再次提交同一改密，提供手动重新登录确认入口。该入口先正常退出；退出失败时保留可重试提示，不能假装已经退出。所有成功、失败、CSRF 刷新和清理都检查认证代次、请求顺序、取消信号与页面生命周期，旧结果不能更新或退出新登录。离页取消读取不代表撤销服务端已提交的密码。

## 阅读和验证

1. 从 [改密卡片](../frontend/src/pages/PasswordChangeCard.tsx) → [统一客户端](../frontend/src/api.ts) → [AuthProvider](../frontend/src/auth.tsx) 阅读表单、未知结果和认证代次转换。
2. 从 [SecurityConfiguration](../backend/src/main/java/com/example/gather/security/SecurityConfiguration.java) → [凭据过滤器](../backend/src/main/java/com/example/gather/security/CredentialVersionFilter.java) → [改密限流](../backend/src/main/java/com/example/gather/security/ratelimit/PasswordChangeRateLimitFilter.java) 区分 CSRF、授权、计数和一次轻量读取。
3. 沿 [PasswordController](../backend/src/main/java/com/example/gather/api/PasswordController.java) → [PasswordChangeService](../backend/src/main/java/com/example/gather/service/PasswordChangeService.java) → [UserMapper](../backend/src/main/java/com/example/gather/mapper/UserMapper.java) 解释事务提交、无行锁 BCrypt、CAS 和提交后清理失败。
4. 对照 [真实 MySQL 用例](../backend/src/test/java/com/example/gather/PasswordChangeIntegrationTest.java)、[浏览器用例](../e2e/password.spec.ts)、[Redis 双实例脚本](../scripts/redis-session-check.mjs) 和 [严格限流脚本](../scripts/auth-rate-limit-check.mjs)。只修改独立测试账号，保留预置演示账号密码；测试存在不代表已通过，实际结果统一见 [验证记录](verification.md)。

演示时新注册一个专用普通账号，用普通窗口和无痕窗口分别登录；在一个窗口改密，展示成功后重登，另一个窗口下次读个人记录时要求登录。两个共享 Cookie 的普通窗口不代表两次独立登录。当前没有忘记密码、邮件验证、管理员重置或密码恢复流程。
