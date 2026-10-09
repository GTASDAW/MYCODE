# 用户注册与个人中心

当前用户可以从登录页进入 `/register` 创建普通账号，注册成功后返回登录页，账号自动填入，密码不保留。登录后通过账号菜单进入 `/profile`，查看登录名、昵称和身份，修改昵称后账号菜单同步更新。登录名创建后固定，本轮资料修改仅包含昵称。

## 接口合同

所有写接口沿用 Cookie Session 和 CSRF。匿名访问 `GET /api/auth/csrf` 取得令牌后也可以注册；匿名可注册不等于免除 CSRF。

| 接口 | 请求 | 成功响应与权限 |
| --- | --- | --- |
| `POST /api/auth/register` | JSON `{username,password,displayName}` | 201，返回 `{id,username,displayName,role}`；允许匿名，不自动登录 |
| `PATCH /api/me/profile` | JSON `{displayName}` | 200，返回当前用户资料；须登录 |
| `GET /api/auth/me` | 无请求体 | 200，从数据库读取当前用户最新资料；须登录 |
| `POST /api/auth/login` | 表单 `{username,password}` | 200，建立登录并返回用户资料；登录后刷新 CSRF |
| `POST /api/auth/logout` | 无请求体 | 200，使本次 Session 失效；退出后刷新 CSRF |

密码及密码哈希从不出现在上述用户响应中。注册角色由服务端固定为 `USER`；请求附带的 `id`、`userId`、`role` 等字段不会授予权限。修改昵称只使用 `@AuthenticationPrincipal AppUserDetails` 的可信 ID，客户端传入其他用户 ID、用户名、角色或密码不会修改这些字段。

参数错误返回 400 `VALIDATION_ERROR`，用户名重复返回 409 `USERNAME_TAKEN`（“用户名已被使用”），未登录返回 401 `UNAUTHENTICATED`，CSRF 无效返回 403 `CSRF_INVALID`。响应和请求日志继续通过服务端生成的 `X-Request-Id` 关联，日志不记录输入密码、哈希或请求体。

## 规范化、校验和数据库约束

| 字段 | 当前后端规则 |
| --- | --- |
| 用户名 | 先 `strip()` 去除首尾空白，再校验 3–32 位 ASCII 英文字母、数字、下划线且首位为字母，最后按 `Locale.ROOT` 转小写保存 |
| 密码 | 不去除空格，8–64 个 UTF-16 代码单元，至少一个 ASCII 英文字母和一个数字，UTF-8 编码不超过 72 字节 |
| 昵称 | 原输入拒绝 C0/C1 控制字符，随后 `strip()`；结果为 1–40 个 UTF-16 代码单元 |

Java `String.length()` 和前端字符串 `length` 都按 UTF-16 代码单元计数，常见汉字计 1，常见 emoji 可能计 2。密码的额外字节上限来自现有 BCrypt：多字节字符即使少于 64 个代码单元，也可能超过 72 字节。服务端在哈希前明确拒绝，避免依赖哈希库截断或异常；用户页面只提示“密码过长，请减少字符数量。”，不要求用户理解编码或算法。

`SecurityConfiguration` 复用 BCrypt 强度 12，`AccountService` 校验后调用 `PasswordEncoder.encode`，数据库只保存带随机盐的哈希。登录用户名也按首尾空白和大小写规范化，但不套用新的注册长度规则，保持既有较长测试账号能够登录。

`users` 已有 `uq_users_username`，原表的用户名和昵称字段足以容纳当前规则，无须修改已执行迁移或新增表。注册直接尝试插入并捕获 `DuplicateKeyException`，因此两个请求把不同大小写、首尾空白规范化成同一用户名时，仍只有一个成功。前端校验和“先查有没有”都不能代替数据库唯一约束。

## 昵称与会话身份分开处理

Session 的 `AppUserDetails` 保留登录时的身份与权限，也包含当时的展示资料快照。修改昵称只更新 `users.display_name`；`GET /api/auth/me` 按可信 `principal.id()` 重新读取数据库，避免把旧快照当作最新资料。

接口不会为了更新昵称重新创建、替换或保存整个 `SecurityContext`。这样既不需要遍历所有内存或 Redis Session，也避免一个迟到的资料请求覆盖并发的 CSRF 轮换、退出或身份变化。这里改变的是可变展示资料的读取来源，没有实现动态角色变更。

同一账号的两个独立 Session 下一次读取 `/api/auth/me` 时都能得到最新昵称；Redis 两实例使用同一数据库，行为相同。其他页面或标签页不会收到实时推送，也没有新增后台轮询；重新打开个人中心或刷新页面会读取资料。退出只注销当前 Session，其他独立登录保持有效。默认内存模式重启仍需重新登录，Redis 模式的保留条件见 [共享 Session 指南](shared-session.md)。

前端认证状态只有 `AuthProvider` 一份。`readProfile` 与 `updateProfile` 通过 `AuthRequestGuard` 记录认证代次、账号 ID 和请求顺序；昵称保存前后使旧读取失效，账号切换后的迟到读取或保存响应不能更新当前用户。页面离开会取消读取与提交；401 交给已有过期处理回到登录。它保护页面状态，不撤销服务端已经提交的昵称修改；重新读取可以确认最终值。

## 按一次请求阅读代码

1. 从 [注册页面](../frontend/src/pages/RegisterPage.tsx) 的提交和 [api.ts](../frontend/src/api.ts) 的 `registerUser` 看 JSON、Cookie、CSRF 与明确的单次 CSRF 重试。
2. 进入 [SecurityConfiguration](../backend/src/main/java/com/example/gather/security/SecurityConfiguration.java)，区分允许匿名注册、写请求 CSRF 校验和管理员授权。
3. 沿 [AuthController](../backend/src/main/java/com/example/gather/api/AuthController.java) → [AccountService](../backend/src/main/java/com/example/gather/service/AccountService.java) → [UserMapper](../backend/src/main/java/com/example/gather/mapper/UserMapper.java)，核对规范化、固定角色、哈希与插入。
4. 打开 [V1 表结构](../backend/src/main/resources/db/migration/V1__create_registration_tables.sql)，解释 `uq_users_username` 如何处理同时注册，而不是靠前端禁用按钮。
5. 沿 [个人中心](../frontend/src/pages/ProfilePage.tsx) → [auth.tsx](../frontend/src/auth.tsx) → [AuthRequestGuard](../frontend/src/authRequestGuard.ts) → [ProfileController](../backend/src/main/java/com/example/gather/api/ProfileController.java)，解释资料修改的可信身份、单一认证状态及迟到响应。
6. 对照 [AccountIntegrationTest](../backend/src/test/java/com/example/gather/AccountIntegrationTest.java)、[账户浏览器场景](../e2e/accounts.spec.ts) 和 [Redis 实例检查](../scripts/redis-session-check.mjs)，区分代码设计、测试覆盖和实际执行结果。

## 验收与演示

使用自己新建的普通账号完成“注册 → 登录 → 报名 → 个人中心修改昵称 → 退出 → 再次登录”。确认登录名不变、账号菜单与个人中心显示新昵称、“我的报名”仍有原记录、管理接口被拒绝。桌面和手机均检查表单校验、重复用户名、读取或保存失败与 Session 过期。

账户测试另覆盖规范化重名并发、UTF-8 字节边界、控制字符、伪造其他人 ID，以及迟到响应时切换账号。Redis 检查增加两独立 Session 在 A/B 上读取最新昵称、实例重启与单会话退出后的重登；这些是检查目标，实际运行结论统一记录在 [验证记录](verification.md)，不能把脚本存在当作通过。

浏览器注册的临时用户在写入前就记录准确用户名和允许的昵称。清理会核对数据库、账号角色、全部活动与账号归属及外部引用，先删本轮活动的报名和活动，再删本轮用户；清理失败不会扩大删除范围。详情见 [交付指南](delivery-guide.md#测试数据清理)。手工注册账号与手工发布活动是持久演示数据，不在自动测试清理范围。

用户名和密码本轮不提供修改流程；如以后扩展密码恢复或邮箱验证，需要单独设计验证凭据和会话失效语义。
