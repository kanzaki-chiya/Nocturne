# 自建 Nocturne 中继

需要一台手机能访问的服务器、一个指向服务器的域名、提供 HTTPS 的 Caddy 或 nginx，以及 **Node.js 24 + systemd** 或 **Docker compose** 二选一。电脑主动连接中继，不需要开放家里的端口。

从 [GitHub Releases](https://github.com/kanzaki-chiya/Nocturne/releases) 下载 `nocturne-relay-<version>.tgz`。包内已带手机网页，不需要额外构建或设置 `--web-root`。安装时服务器还需能访问 npm 的 ws 包。下面的域名与 `<version>` 都要替换。

部署示例位于[仓库 deploy 目录](https://github.com/kanzaki-chiya/Nocturne/tree/main/apps/relay/deploy)，下载与 tgz 对应版本的示例文件；下文 `apps/relay/deploy/` 指源码检出中的路径。

## 1. 启动中继

### Node.js 与 systemd（Linux）

按 Node 官方安装说明安装 Node 24，确认 `node --version`。node/npm 必须位于系统路径，而不是个人主目录的 nvm 路径（服务账户受 ProtectHome 限制）。

```sh
sudo npm install -g ./nocturne-relay-<version>.tgz --prefix /usr/local
/usr/local/bin/nocturne-relay --version
sudo useradd --system --user-group --home-dir /var/lib/nocturne-relay --no-create-home --shell /usr/sbin/nologin nocturne-relay
sudo install -m 600 apps/relay/deploy/relay.env.example /etc/nocturne-relay.env
sudoedit /etc/nocturne-relay.env
```

将 env 文件的 `NOCTURNE_RELAY_PUBLIC_ORIGIN` 改为实际地址，例如 `https://relay.example.com`，小写、无尾斜杠。同机反向代理保持 `NOCTURNE_RELAY_TRUST_PROXY=true`。数据目录由 systemd 创建并归服务账户所有。

```sh
sudo install -m 644 apps/relay/deploy/nocturne-relay.service /etc/systemd/system/nocturne-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now nocturne-relay
sudo systemctl status nocturne-relay
```

示例 ExecStart 为 `/usr/local/bin/nocturne-relay`。若采用其他安装前缀，按 `npm prefix -g` 确认实际路径并修改 unit，确保服务 PATH 中可找到 node。

### Docker compose

安装 Docker Engine 和 compose 插件。将 Dockerfile、compose.yaml 与 tgz 放在同一个部署目录，不要用整个源码仓库作为构建上下文。在该目录创建 `.env`（compose 配置，不是 systemd env 文件）：

```dotenv
RELAY_TGZ=nocturne-relay-<version>.tgz
NOCTURNE_RELAY_PUBLIC_ORIGIN=https://relay.example.com
NOCTURNE_RELAY_TRUST_PROXY=true
```

```sh
docker compose up -d --build
docker compose ps
```

镜像基于官方精确版本 Node 构建，以非 root 的 node 用户运行。`relay-data` 命名卷挂载到 `/data`；端口只发布到宿主 `127.0.0.1:8787`，由宿主反向代理对外服务。改用宿主目录绑定挂载时须给 node 用户写权限。无需镜像仓库账号，不提供预构建镜像。

## 2. 配置 HTTPS 反向代理

deploy 目录中二选一：

- **Caddyfile**：替换域名，合并进 Caddy 配置并重载。Caddy 自动申请/续签证书，自动处理 WebSocket。确保 DNS 正确、服务器 80/443 可达。
- **nginx.conf**：先准备可信 HTTPS 证书，替换域名与证书路径，合并进 nginx 配置，`sudo nginx -t` 后重载。保留 HTTP/1.1、Upgrade/Connection、Host、X-Forwarded-For 与 120 秒超时，**不要重写 Origin**。

手机打开 `https://relay.example.com/` 应看到配对说明。PUBLIC_ORIGIN 必须与实际访问地址一致；不要把 8787 暴露到公网。启用 TRUST_PROXY 时只能允许可信代理访问中继监听端口。

## 3. 邀请与吊销

systemd 管理命令使用同一用户、同一数据目录：

```sh
sudo -u nocturne-relay /usr/local/bin/nocturne-relay invite create --note friend --data-dir /var/lib/nocturne-relay
sudo -u nocturne-relay /usr/local/bin/nocturne-relay invite list --data-dir /var/lib/nocturne-relay
sudo -u nocturne-relay /usr/local/bin/nocturne-relay host list --data-dir /var/lib/nocturne-relay
sudo -u nocturne-relay /usr/local/bin/nocturne-relay host revoke <电脑id> --data-dir /var/lib/nocturne-relay
sudo -u nocturne-relay /usr/local/bin/nocturne-relay device list --data-dir /var/lib/nocturne-relay
sudo -u nocturne-relay /usr/local/bin/nocturne-relay device revoke <手机id> --data-dir /var/lib/nocturne-relay
```

Docker 在运行中的容器执行，自动使用 `/data`：

```sh
docker exec nocturne-relay nocturne-relay invite create --note friend
docker exec nocturne-relay nocturne-relay invite list
docker exec nocturne-relay nocturne-relay host list
docker exec nocturne-relay nocturne-relay host revoke <电脑id>
docker exec nocturne-relay nocturne-relay device list
docker exec nocturne-relay nocturne-relay device revoke <手机id>
```

创建命令只输出一次邀请串，私下发给朋友，不要公开或写入日志。朋友在电脑「设置 › 远程」粘贴邀请、允许远程访问，再用手机扫码配对。吊销立即断开连接。管理命令要求服务已运行；详细参数见[开发文档命令表](https://github.com/kanzaki-chiya/Nocturne/blob/main/docs/apps/relay.md#数据与管理)。

## 4. 推送

服务器须能访问浏览器推送服务（FCM、Apple、Mozilla 等）。无法访问时推送失败，但其他功能正常。手机会话列表点击「开启推送通知」，通知只显示固定提醒，不带会话内容。

iOS 16.4 及以上要先用 Safari 添加到主屏幕，再从主屏幕应用配对并开启推送。主屏幕应用不共享 Safari 的 IndexedDB 身份，添加后需重新配对。

## 5. 备份

停服务后备份**整个数据目录**：systemd 为 `/var/lib/nocturne-relay`，Docker 为 compose 的 `relay-data` 卷（`docker volume ls` 可查实际名称）。备份含私密登记与推送密钥，须限制读取权限，恢复时保留属主与权限。

- 丢失 `vapid.json`：手机要重新开启推送。
- 丢失 `relay-data.json`：所有电脑要重新登记，手机要重新配对。
- Docker 升级保留命名卷；不要执行 `docker compose down -v`，它会删除数据。

## 6. 升级

先备份。Node 方式安装新 tgz：`sudo npm install -g ./nocturne-relay-<version>.tgz --prefix /usr/local`，然后 `sudo systemctl restart nocturne-relay`。Docker 替换 tgz、更新 `.env` 的 RELAY_TGZ，运行 `docker compose up -d --build`。

手机网页由中继提供，不做离线页面缓存；升级后重新打开或刷新即可。电脑端和中继版本差太多时网页提示协议不兼容，建议两边一起升级。

## 7. 常见问题

| 现象 | 检查 |
|---|---|
| WebSocket 连不上、一直离线 | 电脑是否运行并允许远程访问；代理是否转发 Upgrade/Connection、使用 HTTP/1.1、超时大于 30 秒；代理是否能访问本机 8787 |
| 握手 403 | PUBLIC_ORIGIN 是否与实际 HTTPS 域名（含非标准端口）完全一致，Origin 是否被代理改写 |
| 提示需要安全连接 | 必须走可信 HTTPS，不能直接使用服务器 IP 的 HTTP 页面 |
| 收不到推送 | 系统/浏览器通知权限，iOS 是否主屏幕应用，服务端推送出站网络；更换 vapid.json 后关闭再开启通知 |
| 管理命令提示未运行 | 服务是否启动，用户和 data-dir 是否一致；Docker 是否在容器中执行 |

## 安全边界

中继看不到传输内容，但使用者仍需信任中继管理员不会篡改下发网页，详见 [ADR-0052 第 4 节](https://github.com/kanzaki-chiya/Nocturne/blob/main/docs/decisions/ADR-0052-remote-web-client.md#4-端到端加密)。
