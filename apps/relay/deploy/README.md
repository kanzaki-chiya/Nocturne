# Nocturne Relay

独立部署的邀请制密文中继（Node.js >=24）。包内 `public/` 已包含手机网页，默认由服务直接托管，无需 `--web-root`。

```sh
npm install ./nocturne-relay-0.9.0.tgz
node node_modules/nocturne-relay/dist/main.mjs serve --listen 127.0.0.1:8787 --public-origin https://relay.example.com --data-dir ./relay-data
```

生产环境请在可信 HTTPS 反向代理之后运行，并设置与外部地址一致的 `--public-origin`；数据目录应由服务账户独占。管理命令用同一个 `--data-dir`，例如 `invite create --note example --data-dir ./relay-data`。详见项目 `docs/apps/relay.md`。
