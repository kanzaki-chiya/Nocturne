# nctrn

Nocturne 的命令行入口：开源的编程 agent 运行时，终端里直接使用。

## 安装

```bash
npm install -g nctrn
```

要求 Node.js ≥ 24.14。包内是单个自包含文件，没有运行时依赖，也没有安装脚本。

升级：

```bash
npm install -g nctrn@latest
```

## 使用

```bash
nctrn              # TTY 下进入终端界面（TUI）
nctrn --help       # 查看全部参数
```

首次使用需要配置服务商：`nctrn setup` 按向导完成，或参照文档手工编辑配置文件。

## 文档

- 仓库与完整文档：https://github.com/kanzaki-chiya/Nocturne
- 桌面端（自带 Node、图形界面、自动更新）见仓库 Release 页的安装包。

## 许可证

GPL-3.0-only，第三方组件许可见包内 THIRD-PARTY-NOTICES.md。
