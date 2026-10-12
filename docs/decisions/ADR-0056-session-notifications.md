# ADR-0056：会话通知——只在没看时提醒需要确认、出错与完成

- 状态：已接受
- 日期：2026-10-12

## 背景

长任务里三件事都要用户回来看：等审批（`permission.requested` / `question.requested`）、出错停止、长时间运行完成。今天流中断一次隔了一个半小时才发现——用户没在看，会话停了也没人知道。

约束：判定不能进 Core 的 Agent Loop（更不能按客户端写分支）；不新增事件、不改协议；Core 只负责 `settings.json` 里 `notifications` 段的校验与读写。

## 决定

### 1. 三类事件与规则

| 类 | 事件 | 提醒条件 |
|---|---|---|
| 待确认 attention | `permission.requested`、`question.requested` | 没在看即提醒 |
| 出错 error | `turn.completed` 且 `reason === "error"` | 没在看即提醒，不看用时 |
| 完成 done | `turn.completed` 其他非中断结束（`stop`、`max_steps` 等） | 没在看且用时 ≥ `doneAfterSeconds`（默认 60 秒，等于阈值提醒） |

用户中断永远不提醒（效果图称 `interrupted`，现有协议值是 `aborted`）。只对本次运行中实时到达的事件提醒；重放、恢复补写、打开历史会话读到的事件不提醒。现有子会话非交互，内部权限/提问请求不会冒泡到父会话；父会话收到的是 `task` 工具本身的审批事件，按父会话判断并用父会话标题。以后若增加转发，也须保持父会话归属。

「在看」的定义两端各自解释：桌面端 = 窗口有焦点且该会话是当前显示的会话；TUI = 终端有焦点（焦点报告回送 `ESC [ I`）。

### 2. 配置：settings.json 共用，Core 只做校验读写

```json
"notifications": {
  "enabled": true,
  "events": { "attention": true, "error": true, "done": true },
  "doneAfterSeconds": 60,
  "sound": true
}
```

- 缺省值如上。`doneAfterSeconds` 为非负整数。
- 白名单新增 `notifications`：与 `config.json` 共用 schema 逐字段参与通用合并（手写优先、项目需信任——不可信项目忽略，与其他白名单字段同一规则，无特例）。
- `settings.json` 损坏时忽略文件并警告；通知字段无效时逐字段忽略并警告，其余合法字段继续生效，未知成员原样保留但不参与合并。手写配置继续使用现有严格 schema 校验规则。
- `SettingItem` / `SettingsPatch` 逐字段：`notifications.enabled`、`notifications.events.attention`、`notifications.events.error`、`notifications.events.done`、`notifications.doneAfterSeconds`、`notifications.sound`；`effective` 遵循现有 string 风格（`"true"` / `"false"` / `"60"`）；`null` 清除。
- TUI 经 Core 公开 API（`describeSettings`）读生效值，每次通知判定重读，同一 Runtime 写入后立即生效；其他进程改文件仍需下次启动加载。

### 3. 为什么判定放客户端

事件语义（permission / question / turn.completed）Core 都有，但「用户在看」是纯客户端状态（窗口焦点+当前会话、终端焦点）。Core 拿不到，也不应拿（Core 不得依赖 UI）。所以判定函数两端各写一份，不共用模块、不进 Core，避免违反依赖方向（Core → 客户端）。

### 4. 桌面端：Windows 点击回调为什么不用 notification 插件

`tauri-plugin-notification` 在桌面端不支持点击回调。点击必须切到对应会话并把窗口带到前台，所以在 `src-tauri` 用 WinRT toast 库（`tauri-winrt-notification` 或同等）自实现外壳命令：`on_activated` 回调 emit 带 `sessionId` 事件给前端切会话，外壳负责 unminimize + set_focus。非 Windows 平台编译能过、调用时静默不发。AUMID：安装版用 Tauri bundle 的 identifier；开发模式未注册时退回库默认行为，不崩溃。同一会话新通知替换旧的（tag/group = sessionId），切到该会话时撤掉；`sound: false` 时静音 toast；同时调 `requestUserAttention` 让任务栏闪烁。详情与库版本见桌面端实现报告。

### 5. TUI：焦点报告与 BEL

启动时开焦点报告 `CSI ?1004h`，所有退出路径关 `CSI ?1004l`。`ESC [ I` / `ESC [ O` 在进 Ink 前摘除并记焦点态（跨块拼接，不与 Esc / Alt+键冲突）。从未收到回送（终端不支持）时按没在看处理。需提醒时向 stdout 写 BEL（`\x07`），走帧外写出通道。`sound` 设置不影响 TUI（声音由终端 `bellStyle` 决定）。不做 OSC 9 / 系统通知。

### 6. 不做的事

通知上的操作按钮（直接批准/拒绝）、OSC 9、移动端。侧栏状态只在内存里，不持久化。

## 后果

- 正面：长任务等审批、出错、完成都会把用户叫回来；配置与现有设置层同一套读写、来源标注、覆盖提示。
- 负面：判定两份实现，规则变化要改两处（以本 ADR 第 1 节表格为准）。

## 备选方案

- **Core 统一下发通知事件**：Core 不知道焦点状态，下发了客户端还是要按在看过滤，多一跳无收益。
- **判定共用模块**：两端依赖方向不允许共用 Core；桌面端（TS）与 TUI 之间建共享包为六行规则不值，且正文格式（toast 文案 vs 响铃）本就不同。
- **`doneAfterSeconds` 逐客户端存**：阈值是用户意图（多长的任务值得打扰），应跟随设置漫游，两端一致；客户端只存「在看」这种本机状态。
