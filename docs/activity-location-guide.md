# 活动地点：地图选点与导航

发布、编辑活动时可在文字地点旁打开“地图选点”，搜索场地或点击地图取得地址，按需补充楼层、房间，再点击“确认使用此地点”。确认前只修改弹窗草稿，取消不会改表单；发布或保存后才写数据库。手动改文字地点会清除旧坐标，避免地址已变而导航仍指旧位置。历史活动没有坐标，不猜测或自动地理编码。

详情有坐标时提供“查看地图”及“在高德查看 / 导航”；查看权限与活动详情一致，不要求报名。地图按点击加载，未配置或服务失败仍可使用文字资料；外部链接只生成固定 `https://uri.amap.com/marker` 地址，使用 GCJ-02、编码后的活动名称和 `noopener noreferrer`。导航不代表报名、签到或已到达现场。本人主动点击“我的报名”中的到场签到才读取一次设备定位，资格和写入合同见 [签到指南](checkin-export-guide.md#本人到场定位签到)。

## 申请与本机配置

1. 从[高德开放平台](https://console.amap.com/)登录自己的开发者账号，在应用管理创建应用、添加 Key，平台选择 **Web端（JS API）**，取得 Key 及对应安全密钥 `securityJsCode`。按实际访问地址设置控制台允许的域名；服务权限、额度与费用以控制台为准，本轮没有代申请、购买或开通收费服务。参考[官方准备说明](https://lbs.amap.com/api/javascript-api-v2/prerequisites)。
2. 在仓库根目录执行下面的 Windows 命令。它准备忽略目录中的配置，并将文件权限限制为当前用户、SYSTEM 和管理员；旧文件只补可选空字段，已有凭据保留。

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-amap.ps1
   ```

3. 地图选点保留 `jsKey`、`securityJsCode` 两个字符串。要启用到场定位签到，还需在高德控制台为应用另加平台为 **Web服务** 的 Key，核对坐标转换服务权限及后端出口限制；它不是 JS API Key 或安全密钥。申请入口见[Web服务入门指南](https://lbs.amap.com/api/webservice/gettingstarted)，接口要求见[坐标转换文档](https://developer.amap.com/api/webservice/guide/api/convert)；权限、额度和费用以控制台为准，不由本项目自动申请或购买。
4. 在本机编辑 `.runtime/amap.json`，字段为 `jsKey`、`securityJsCode`、可选 `webServiceKey` 三个字符串。`webServiceKey` 留空或旧文件缺少此字段时只禁用定位签到，已有 JS 地图可继续使用；再次执行第 2 步会为旧文件补空字段并保留既有值，同时核对私有权限。不要把任何私有值发到聊天、截图、日志或提交到 Git，不要混用不同平台的 Key。
5. 配置改变后重启本项目：执行 `scripts/stop-dev.ps1`，再执行 `scripts/start-dev.ps1 -SkipBuild`；源码改变时先完成新构建。默认内存 Session 重启后需要重新登录。地图选点与定位转换分别核对，不以地图已显示推断 Web服务 Key 可用。

`start-dev.ps1` 优先使用成对的进程环境变量 `AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE`，不会把一项环境变量与另一份文件密钥混用；独立的 `AMAP_WEB_SERVICE_KEY` 优先于文件的 `webServiceKey`。未显式提供相应环境变量时读取私有 JSON；文件格式或权限不正确时禁用依赖该文件的能力并给出不含凭据的提示，文字地点仍可使用。`AMAP_WEB_SERVICE_KEY` 映射后端 `app.maps.web-service-key`，不映射为 JS 配置；变量仅作用于本次启动，不修改系统环境或 PATH。

容器演示通过对应后端的三项环境变量注入，默认均为空；默认模式与 Redis 两实例沿用相同配置。不要把实际凭据写入镜像、源码或工作流。当前只配置回环演示，申请 Key 不会让本机网站变成公网网站。

## 接口、坐标和兼容

- 活动创建/编辑请求及所有活动响应增加可空 `locationPoint: {longitude, latitude}`，固定为 GCJ-02；原 `location` 字段、排序、分页与统计口径不变。
- 创建省略或 null 表示没有地图点。编辑省略时保留原点；若文字地点真实改变却没有提交新点，则清除旧点。显式 null 清除，完整对象替换；缺半边、非数字或越界返回 400。前后端都先校原始范围，再以十进制 HALF_UP 规范为七位小数。
- 复制活动保留文字与坐标，但开始、结束、报名截止时间仍清空。只能编辑未开始且未取消活动；活动创建/地点或坐标实际编辑按原事务追加 CREATE/EDIT 审计，坐标为明确白名单 string/null，历史审计不回填。
- V14 只新增成对可空的 `activities.location_longitude DECIMAL(10,7)` 和 `location_latitude DECIMAL(9,7)`，范围分别为 ±180、±90，CHECK 强制空值成对且结果为真。旧数据均为空。V15 的签到方式与版本保存在报名行，仍不猜测历史活动坐标。

## 地图接入与异步边界

`GET /api/maps/config` 公开返回启用状态、JS Key 与固定代理前缀，no-store；安全密钥和 Web服务 Key 始终留在后端。本人报名分页仅返回 `locationCheckInEnabled` 配置就绪布尔。JS API 2.0 仅在打开地图后加载，受控适配器封装提供商所需的全局桥接；不在浏览器全局或持久存储保存认证和活动草稿。采用[官方 serviceHost 代理方式](https://developer.amap.com/api/javascript-api-v2/guide/abc/jscode)，服务端仅连接固定高德 HTTPS 路径，不接受任意上游、请求正文或客户端凭据，拒绝调用方注入安全码，覆盖调用方 Key。

代理限制参数、重定向、并发 16、包含正文的 5 秒时限及 2 MiB 响应，验证 JSON/JSONP 并过滤安全码反射；不记录查询参数、位置搜索词、凭据或原始上游异常。该能力仅作本机演示，不宣称具备公网防滥用或可用性保证。未配置时无外部请求，代理明确返回不可用。

SDK 加载订阅去重，失败只接受手动重试；弹窗轮次、活动/复制来源、路由、认证代次及操作顺序共同约束结果。离页或关闭销毁地图实例与事件；旧搜索、逆地址、SDK 成功/错误和 finally 不得回填新草稿、打开旧弹窗或覆盖新状态。提供商畸形异步回调也转换为中文错误，不抛出未处理异常。

源码阅读：[接口与持久化](../backend/src/main/java/com/example/gather/service/ActivityService.java)、[受限代理](../backend/src/main/java/com/example/gather/maps/MapProxyService.java)、[地点表单](../frontend/src/pages/ActivityLocationField.tsx)、[SDK 适配](../frontend/src/amapAdapter.ts)。实际测试与未验证项见[验证记录](verification.md)。

未配置流程、提供商契约替身、真实 MySQL 业务、真实 JS 地图及真实坐标转换分别核对，替身不代替提供商联调。各环境已执行范围统一见 [验证记录](verification.md)。

## 设备定位与手机限制

签到使用浏览器原生 `navigator.geolocation.getCurrentPosition` 的 WGS84 经纬度，单次高精度、禁用缓存、10秒超时；后端以独立 Web服务 Key 调用固定 HTTPS 坐标转换端点，`coordsys=gps`、`output=JSON`、仅单点，得到 GCJ-02 后再与活动点计算距离。没有自行使用近似转换公式，也不拿 JS Key 代替 Web服务 Key；未配置不发转换请求，转换失败返回503且不进入签到写事务。请求中的原始用户经纬度不存库、不写审计或请求日志，也不进入 URL 或浏览器持久存储。

原生定位要求[安全上下文与用户许可](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition)。桌面 localhost/回环的开发例外不等于真实手机通过局域网 HTTP 可定位；真实手机需要其浏览器信任的 HTTPS 入口、可达的本机服务及定位授权，设备自己的 localhost 也不指向开发电脑。仓库不会因填写 Key 自动配置 HTTPS、证书或公网发布。桌面/手机视口模拟及模拟坐标不能证明真实手机 GPS、Safari 或真实高德坐标转换成功；没有合适连接或精度不足时保留管理员确认入口，不自动重复请求定位。
