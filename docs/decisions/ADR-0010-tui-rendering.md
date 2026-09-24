# ADR-0010：TUI 渲染方案选型

- 状态：提议
- 日期：2026-10-21

## 背景

Phase 4 需要一个终端 UI 渲染层（[apps/tui.md](../apps/tui.md)）。约束：

- **Windows 为主开发机**：Windows Terminal 与旧版 conhost 都要能跑；conhost 无真彩、无 Synchronized Update Mode，但会忽略不认识的序列。
- **中文一等公民**：会话内容与状态栏大量中文，CJK 宽字符（占两格）的截断、对齐、覆盖写必须正确；中文输入法（IME）候选窗位置是已知难点。
- **依赖纪律**：仓库现行约定是"CLI 第三方运行时依赖为零"（cli.md）。TUI 是否沿用需要显式决定。
- **维护成本**：渲染层出问题（错位、残影、重绘闪烁）很难用单测覆盖，选型的"被踩过的坑数量"比 API 美观度重要。
- 架构上渲染层必须可替换：`SessionView` reducer 在 `protocol`，TUI 内部组件化，任何终端库都可被换掉而不影响 Core。

## 决定

**apps/tui 使用 Ink + React（`ink` + `react` 两个运行时依赖，外加 `ink-testing-library` 作为 devDependency）。**

- "零第三方运行时依赖"约定改为**按包生效**：`packages/core` 与 `apps/cli` 保持零依赖；`apps/tui` 允许引入 ADR 批准的终端依赖。理由：该约定的初衷是 Core 可分发性与 CLI 启动轻量，TUI 是独立的可选客户端，为自研渲染付出的缺陷成本高于两个成熟依赖的体积成本。
- `apps/cli` → `apps/tui` 仅存在 `nctrn --tui` 的**惰性** `import()` 边界：非 TUI 路径不加载 React/Ink，CLI 启动性能与依赖安装面不变。
- 依赖仍锁精确版本（沿用仓库 renovate/lockfile 惯例），不引入 ink 生态的额外组件库（如 ink-text-input）：输入框用 `useInput` 自实现（约百行，键位路由更可控）。
- 渲染模型：`<Static>` 承载已完结时间线条目（append-only，契合事件溯源），活动区用普通组件随 `view.revision` 重绘——这条不依赖 Ink 专有特性，替换渲染器时设计不变。

## 后果

正面：

- Ink 是 Coding-Agent TUI 的事实标准（gemini-cli 等同类项目均基于它），React 组件 + Yoga flexbox 布局使 resize/窄终端重排是框架能力而非自研逻辑；
- `<Static>` 直接解决"已完结条目进 scrollback、交给终端原生滚动复制"的需求；
- `ink-testing-library` 提供虚拟终端渲染断言，离线测试可断言 40 列窄终端下的真实帧内容；
- CJK 宽字符处理内建（string-width + 输出网格对宽字符劈裂的清理），IME 候选窗定位经 Synchronized Update Mode 在主线上持续修复（Ink ≥ 近期版本已合入相关 PR）。

负面与约束：

- 引入 React + Ink 的依赖体积（install 量级数十 MB，传递依赖约 30+ 包）；TUI 之外的包不受影响。
- Ink 无内置输入框组件，需自实现 Composer（同时是好处：五键权限、Ctrl+C 语义由我们完全控制）。
- **已知风险**：conhost 与部分终端的 IME 候选窗定位仍可能偏移（Synchronized Update 需要终端支持，conhost 不支持但会忽略）；窄终端 resize 瞬间可能出现 ghost line（Ink 上游已知行为）。验收阶段必须在 Windows Terminal 与 conhost 实测中文输入与 resize。
- 退路：若 Ink 在目标终端出现不可接受缺陷，因渲染层收敛在 `apps/tui` 内、视图状态来自 `protocol` reducer，可换成自研 ANSI 渲染而不动 Core 与视图层——代价是丢掉 Ink 的布局/测试生态。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| **Ink + React** | **采用** | 生态最大、维护活跃、CJK 问题有上游持续投入；组件模型与 `<Static>` 恰好匹配"回放 + 活动区"设计 |
| blessed / neo-blessed | 否决 | blessed 自 ~2016 年起事实停更，neo-blessed 分叉维护量低；命令式 widget API 与事件溯源模型匹配差，已知 Windows 兼容问题无人修 |
| terminal-kit | 否决 | 仍在维护但社区小、命令式 API；布局与 diff 重绘要自己写，综合成本接近自研 |
| 自研 ANSI + node:readline keypress | 否决（保留为退路） | 零依赖、控制最强，但 wcwidth 表、行宽折返、增量重绘、resize 重排、键序列解析（含 IME 组合串）全部自建；缺陷面集中在最难单测的渲染层，迭代速度不可接受 |

## 附：对既有约定的影响

- modules.md §4 增加 `apps/tui` 客户端条目；`tui` 从"未来模块"表移除。
- cli.md 增补 `--tui` 参数与"零依赖约定按包生效"的边界说明。
- depcheck 增加：apps/tui → 其他 apps 禁止；apps/cli → apps/tui 仅允许 `--tui` 委托这一条惰性边。
