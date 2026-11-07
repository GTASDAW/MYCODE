# 本机与手机演示启动

在项目根目录执行；首次开发环境准备仍使用README的`setup-local.ps1`。一个入口负责启动现有前后端，存在手机私有配置时再启动HTTPS。数据库目录、账号及业务规则沿用现有实现。

```powershell
# 启动电脑；手机配置就绪时同时启动手机入口
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1

# 同一份业务代码已构建时，复用现有后端JAR
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -SkipBuild

# 只检查状态、地址和故障原因
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -Action Status

# 只启动电脑，不改变已有手机服务
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -DesktopOnly

# 停止本项目托管的手机入口、前后端和本地MySQL，保留数据与证书
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -Action Stop
```

电脑地址固定为`http://127.0.0.1:5173`，脚本分别检查页面、后端数据库健康与前端API代理。已运行的服务通过归属检查后复用；修改后端代码后应先停止再正常启动，使新包生效，不使用`-SkipBuild`。手机地址由私有配置的电脑IP和HTTPS端口生成；手机浏览器的`127.0.0.1`指向手机自身。后端重启后，内存Session失效，需要重新登录。

已有`start-dev.ps1`和`stop-dev.ps1`仍可使用；它们只管理原电脑环境。新入口不添加依赖或安装证书工具，缺失既有npm依赖时沿用原启动脚本的`npm ci`；缺少首次准备的JDK/MySQL/Node时，按README准备，已安装的运行环境继续复用。

## 手机首次配置

复制模板，然后填写电脑和单台手机当前的Wi-Fi IPv4地址。两个地址可以处于已由网络管理员允许互通的不同网段。只接受私网IPv4字面值，不接受域名、CIDR或全网地址。

```powershell
New-Item -ItemType Directory -Path .runtime/mobile-https -Force
Copy-Item scripts/mobile-https.config.example.json .runtime/mobile-https/config.json
```

| 私有字段 | 含义 |
| --- | --- |
| `bindAddress` | 电脑当前局域网IPv4，必须仍属于本机网卡 |
| `phoneAddress` | 唯一允许访问的手机当前IPv4，变更时更新此值 |
| `httpsPort` / `certificatePort` | 网站HTTPS端口及仅下载CA公钥的HTTP端口，默认8443/8444；1024–65535内两个不同值，避开3307/8080/5173 |
| `certificateFile` | 覆盖电脑IP的站点证书，默认`.runtime/mobile-https/server.pem` |
| `privateKeyFile` | 对应站点私钥，默认`.runtime/mobile-https/server-key.pem` |
| `caFile` | 签发CA的公共证书，默认`.runtime/mobile-https/gather-dev-ca.crt` |

三份证书文件必须位于本仓库`.runtime`内，不能通过软链接指向其他目录。配置、证书、私钥、进程记录和日志均被Git忽略；可提交的模板只含示例地址。存在原手机证书时直接复用，不重新生成CA，也无需手机重复安装。

没有证书时，先自行准备已获授权的本地开发CA和IP证书。若已按此前本机流程备好`.tools/mkcert/mkcert-v1.4.4-windows-amd64.exe`，可在独立且权限受限的`.runtime/mobile-https/ca`作为`CAROOT`生成。下例中的IP必须换成`bindAddress`，不要覆盖仍在使用的证书或CA；不要向手机发送`rootCA-key.pem`或`server-key.pem`。工具没有安装时先报告缺失，不由启动命令下载软件。

```powershell
# 仅第一次、确认该独立目录尚无在用CA时准备；不执行mkcert -install
$env:CAROOT = Join-Path $PWD '.runtime/mobile-https/ca'
New-Item -ItemType Directory -Path $env:CAROOT -Force
# 先通过目录“属性 → 安全”将CA/私钥目录限制为本人、SYSTEM和管理员
& .\.tools\mkcert\mkcert-v1.4.4-windows-amd64.exe `
  -cert-file .runtime/mobile-https/server.pem `
  -key-file .runtime/mobile-https/server-key.pem 192.168.1.10
Copy-Item (Join-Path $env:CAROOT 'rootCA.pem') .runtime/mobile-https/gather-dev-ca.crt
```

手机需要手动信任这份独立开发CA；下载入口只提供`http://电脑IP:certificatePort/gather-dev-ca.crt`这一份公钥。确认是自己的开发CA后再安装，测试完成后可在手机设置中移除。网站仍使用HTTPS端口；HTTP下载端口不代理网页或登录。该流程不配置公网域名、不改变公司路由或Windows系统根信任。

手机启停需要有权限管理这条专用Windows防火墙规则。使用管理员PowerShell启动；规则仅允许配置中的单台手机、当前电脑IP、两个端口及Node程序，不开放整个网段。后台进程隐藏启动；反复执行相同命令会核对并复用已验证进程，不重复开服务。占用端口的非托管程序、复用PID或不一致规则会明确拒绝处理。

## 日常检查与恢复

改手机IP或电脑IP前，先使用原配置停止手机服务；随后编辑私有配置，再启动。修改电脑IP还需要证书覆盖新IP，手机IP变化不需要重签证书。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\mobile-https.ps1 -Action Stop
# 编辑 .runtime/mobile-https/config.json；必要时更新对应的IP证书
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -SkipBuild
```

`demo.ps1 -Action Status`只读检查。手机单独管理也可运行`mobile-https.ps1 -Action Start|Status|Stop`；它不停止Java或MySQL。更换证书或私钥也应先停止再启动，使新TLS文件生效。私有配置字节或路径改变时不会将旧进程当作新配置复用；旧进程的停止使用已保存且再次验证的归属和规则范围，不按新地址扩大操作。

| 现象 | 下一步 |
| --- | --- |
| 电脑页面或API健康失败 | 运行统一启动命令；查看`.runtime/backend.out.log`、`backend.err.log`和`frontend.err.log`，不要重置数据库 |
| 提示本机没有配置的IP | 核电脑当前IPv4，停止旧手机入口，更新配置与IP证书 |
| 电脑自检成功，手机打不开 | 核手机当前IP是否等于`phoneAddress`、网络是否允许互通；不要关闭防火墙或扩大到全网 |
| 证书缺失、过期、IP不匹配或CA验证失败 | 修正证书链及配置；脚本不会跳过TLS校验或自动换CA |
| 手机进入页面后要求登录 | 后端重启后正常重新登录；不要在CA下载HTTP端口登录 |
| 定位权限被拒或精度不足 | 在手机系统和浏览器检查精确位置权限，回到页面主动重试；300米、100米精度和活动时间规则保持 |

程序日志只记录有限错误类别，不输出地图凭据、Cookie、请求正文或定位坐标。已撤除的临时GPS诊断网页保持404，正常入口也不会自动采集位置。实际验证结果见[验证记录](verification.md)。

本机相关工具回归命令为`node --test scripts/mobile-https.test.mjs scripts/mobile-https-powershell.test.mjs`；PowerShell专项需要Windows PowerShell 5.1，在其他平台明确跳过，不能据此声称完成Windows生命周期验证。真实启停及TLS检查另需上述本机配置与现有证书。
