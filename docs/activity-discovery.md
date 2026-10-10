# 活动发现：搜索、筛选、分页与 URL 状态

用户可以在 `/activities` 按标题或地点搜索活动、筛选状态并翻页。页面读取新的分页接口，当前页卡片、匹配总数和两项统计都来自 MySQL；查看详情、刷新、登录后返回列表时，已提交的查询条件保留。

## 接口与兼容性

`GET /api/activities/search` 可匿名调用，也支持普通用户和管理员：

| 参数 | 默认值 | 规则 |
| --- | --- | --- |
| `keyword` | 空字符串 | 标题或地点的字面子串，最多 200 个 UTF-16 代码单元；不裁剪首尾空格 |
| `status` | `ALL` | `ALL`、`OPEN`、`FULL`、`STARTED`、`CANCELLED`、`UPCOMING`，区分大小写 |
| `page` | `1` | 正整数，按 Java `int` 接收 |
| `pageSize` | `12` | 1–100 的整数 |

例如，`/api/activities/search?keyword=React&status=OPEN&page=1&pageSize=12` 查询标题或地点包含 `React` 的可报名活动。参数作为绑定 SQL 值传入，不拼接关键词。非法页码、数量、状态、超长关键词或无法转换的数字返回 HTTP 400，错误格式仍为 `{code:"VALIDATION_ERROR",message:...}`。

响应结构：

```typescript
interface ActivitySearchPage {
  items: ActivityView[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    upcomingActivities: number;
    availableSeats: number;
  };
}
```

`items` 继续包含原活动详情字段，包括 `waitingCount`、`registrationStatus`、取消原因和时间。`registrationStatus` 只属于服务端登录身份对应的当前用户；匿名请求得到 `null`。客户端传入 `userId` 不会改变查询身份，接口不会返回其他人的报名记录。

旧 `GET /api/activities` 保留数组响应和排序，`GET /api/activities/{id}` 保留详情合同。发现页改用分页接口，旧调用方不需要把数组改成分页对象。

## 状态与统计

公开和管理列表共用 `ActivityQuerySql.FILTER`：

| 状态 | 中文选项 | 匹配规则 |
| --- | --- | --- |
| `ALL` | 全部状态 | 所有活动 |
| `OPEN` | 报名中 | 未取消，开始时间晚于请求当前时间，有效人数少于名额 |
| `FULL` | 已满员 | 未取消，尚未开始，有效人数等于名额；仍可加入候补 |
| `STARTED` | 已开始 | 未取消，开始时间等于或早于请求当前时间 |
| `CANCELLED` | 已取消 | 取消时间非空，不受原开始时间影响 |
| `UPCOMING` | 即将开始 | 未取消且尚未开始，包含满员活动 |

`total` 是关键词与状态共同筛选出的全部活动数。`summary` 也基于整个匹配集合：`upcomingActivities` 只统计其中未取消、尚未开始的活动，`availableSeats` 只累加这些活动的 `capacity - registeredCount`。候补不占名额，已开始或已取消活动不提供剩余名额。因此筛选 `CANCELLED` 或 `STARTED` 时两项统计为 0；筛选 `FULL` 时剩余名额为 0。

例如 13 场符合条件的未来活动，每场有 2 个未占用名额，第一页只有 12 张卡片，但总数仍为 13，统计仍为 13 场、26 个名额。前端不能根据当前页卡片推算这些数字。加载和读取失败时显示 `—`，不会把未知统计伪装成 0。

## 一次查询保持一致

`ActivityService.search` 开启只读 `REPEATABLE_READ` 事务，一次读取服务器时钟并截取为 UTC 微秒。聚合 SQL、当前页 SQL 和 `ActivityView` 状态映射共用这个时间与同一个 InnoDB 一致性快照。

聚合先取得总数与统计，分页再取得卡片。如果另一个事务在两条 SQL 之间取消活动，本次响应仍读取原快照，避免总数、统计和卡片混用新旧状态；下一次请求会看到提交后的状态。公开搜索只有普通一致性读取，没有活动写锁。

分页按 `starts_at ASC, id ASC` 排序，以 ID 消除相同开始时间的顺序歧义；偏移量用 `long` 计算。超过末页时，接口保留请求页码、真实总数与统计，`items` 为空，由页面修正导航。不同请求间活动和人数可以变化，稳定排序不等于冻结整个翻页过程。

SQL 使用 `LOCATE(#{keyword}, a.title)` 和地点的同类条件。`%`、`_`、反斜杠及连续空格作为关键词内容，没有 `LIKE` 通配符语义；大小写等匹配行为遵循数据库当前排序规则。本轮没有为任意字面子串增加未经验证的索引、搜索服务或缓存。分页限制单次返回数量，不能据此宣称子串查询获得 B-tree 高性能或整体查询更快。

报名、用户取消、编辑和组织者取消继续使用原有 `READ_COMMITTED` 与活动主键行锁，公开读取不改变写事务规则。

## URL、表单和返回导航

`activityDiscovery.ts` 负责解析和序列化列表查询。已提交的 `keyword/status/page/pageSize` 来自 URL；输入框有独立草稿，键入文字不会立即替换现有结果。

- “查询”提交草稿并回第一页；在第一页、条件相同时也会真正重新请求。
- 改状态或每页数量立即请求并回第一页，状态筛选沿用已提交关键词。每页数量提供 12、24、48；URL 中其他合法数量也加入选项。
- “重置”与“清除筛选”清空关键词和状态，回第一页，保留每页数量。
- URL 省略空关键词、`ALL`、第一页和默认 12 条；接口请求仍携带四个参数。
- 未知参数被移除，非法状态与数字回到默认值。超过 200 的关键词清空并显示提示，其他合法条件保留，不偷偷截成另一个搜索词。
- 页码越界时用 `replace` 回最后一个合法页；总数为 0 时最多回第一页一次，之后显示空结果。校正期间显示加载，不展示非法分页。

卡片的详情链接把规范列表路径编码到 `from` 参数。详情的“返回活动列表”保留搜索、状态、页码和数量；刷新详情、前往登录再回详情也保留来源。没有来源的直接详情仍显示“返回全部活动”。来源只接受精确内部 `/activities` 路径及规范化查询，不接受外部网址、其他页面、片段或非法路径字符。

返回列表后重新读取接口，因此报名后能看到最新个人状态和剩余名额。`useResource` 在条件、账号或页面切换时中止旧读取；只有当前依赖与请求版本的结果能显示，迟到旧查询不能覆盖新卡片或统计。没有轮询或额外认证状态副本。

## 验收与代码阅读

本机搜索自己创建的未来活动，切换状态、翻页、刷新、前往详情；匿名用户从详情登录并报名，再点“返回活动列表”，检查条件、个人状态和统计。手机也支持表单与每页数量；连接失败可按原条件重新加载，空结果可清除筛选。

推荐阅读顺序：

1. `frontend/src/activityDiscovery.ts`：参数、默认值、来源路径安全。
2. `frontend/src/pages/ActivitiesPage.tsx`：草稿与查询、统计、刷新与越界修正。
3. `frontend/src/api.ts` 与 `useResource.ts`：四参数请求、中止与过期结果保护。
4. `ActivityController → ActivityService.search → ActivityMapper.searchTotals/search → ActivityQuerySql`：可信身份、校验、时间与快照、共享筛选 SQL。
5. `frontend/src/components.tsx` 与 `pages/ActivityDetailPage.tsx`：详情来源、登录与返回。

`ActivitySearchIntegrationTest` 使用真实 MySQL，验证旧接口、字面字符、六状态与微秒边界、跨页统计、最大页码、可信个人状态、非法参数、单次时钟读取，以及聚合与分页之间真正提交取消事务的快照一致性。请求追踪回归确认指标路由为 `/api/activities/search`，不把搜索词写入日志或指标标签。

`frontend/tests/discovery.test.mjs` 检查 URL 与来源安全；`e2e/discovery.spec.ts` 提供桌面/手机真实分页、历史导航、登录返回、报名刷新、筛选统计、失败重试和迟到读取回归。Compose 冒烟与 Redis 双实例脚本也检查公开分页和当前用户状态。实际执行数量和结论统一见 [验证记录](verification.md)，CI 与复现见 [交付指南](delivery-guide.md)。

## 面试讲解

沿“总数为什么不能从一页卡片算 → 聚合与分页为什么需要同一快照和时间 → 筛选为什么写入 URL → 从详情返回为什么重新读取”展开。再用满员或取消活动解释候补与剩余名额，说明公开列表只返回当前用户的个人状态。

本轮改善查询合同、统计一致性和导航体验；任意子串、大偏移分页和跨请求翻页的成本仍需另行测量。历史报名 SQL 对照仍按 [查询优化复盘](query-optimization-review.md) 的固定版本合同复现，不能把当前 Mapper 变更混入原实验。
