# 界面功能地图

> 桌面端、手机网页与 TUI 主要界面到源码、测试与截图定位的索引表；路径由 `scripts/check-ui-map.mjs` 随 `pnpm lint` 校验。

## 桌面端

### 主界面与面板

| 界面名 | 进入方式 | 主组件文件 | 测试文件 | `pnpm shot` 步骤 / CDP 定位 |
|---|---|---|---|---|
| 新会话 | 侧栏点「新会话」，或无选中会话时的默认页 | `apps/desktop/src/App.tsx`、`apps/desktop/src/Composer.tsx` | `apps/desktop/test/app.test.tsx`、`apps/desktop/test/composer.test.tsx` | `await click('text=新会话'); await waitFor('.hero-composer');` |
| 会话 | 侧栏点任意会话行 | `apps/desktop/src/Conversation.tsx`、`apps/desktop/src/ConversationHeader.tsx` | `apps/desktop/test/conversation.test.tsx`、`apps/desktop/test/conversation-header.test.tsx` | `await click('.side .tree button.item'); await waitFor('[aria-label="会话消息"]');` |
| 搜索 | 侧栏点「搜索」，或按 `Ctrl+K` | `apps/desktop/src/SearchDialog.tsx` | `apps/desktop/test/search-dialog.test.tsx` | `await click('text=搜索'); await waitFor('[role="dialog"][aria-label="搜索"]');` |
| 定时任务 | 侧栏点「定时任务」 | `apps/desktop/src/SchedulePage.tsx` | `apps/desktop/test/schedule-page.test.tsx` | `await click('text=定时任务'); await waitFor('section[aria-label="定时任务"]');` |
| 组曲 | 侧栏点「组曲」 | `apps/desktop/src/SuitesPage.tsx` | `apps/desktop/test/suites.test.tsx` | `await click('text=组曲'); await waitFor('section[aria-label="组曲"]');` |
| 上下文用量 | 输入框旁点 `aria-label` 以「上下文用量」开头的按钮 | `apps/desktop/src/ContextUsage.tsx` | `apps/desktop/test/context-usage.test.tsx` | `await click('button[aria-label^="上下文用量"]'); await waitFor('.context-usage-popover');` |
| 会话概览 | 标题栏点「会话概览」图标按钮 | `apps/desktop/src/PanelChrome.tsx` | `apps/desktop/test/panel-host.test.tsx` | `await click('button[aria-label="会话概览"]'); await waitFor('[aria-label="会话概览"][role="dialog"]');` |
| 右侧面板 · 新标签页 | 标题栏点「右侧面板」，或面板栏点「新标签页」 | `apps/desktop/src/SidePanel.tsx`、`apps/desktop/src/PanelHost.tsx` | `apps/desktop/test/side-panel-ui.test.tsx`、`apps/desktop/test/panel-host.test.tsx` | `await click('button[aria-label="右侧面板"]'); await waitFor('[aria-label="右侧面板"]');` |
| 右侧面板 · 变更 | 右侧面板新标签页点「变更」，或按 `Ctrl+Shift+G` | `apps/desktop/src/SidePanel.tsx`、`apps/desktop/src/TurnChangesCard.tsx` | `apps/desktop/test/side-panel-ui.test.tsx`、`apps/desktop/test/turn-changes.test.tsx` | `await click('button[aria-label="右侧面板"]'); await click('text=变更');` |
| 右侧面板 · 文件（快速打开） | 右侧面板新标签页点「文件」，或按 `Ctrl+P` | `apps/desktop/src/PanelChrome.tsx`、`apps/desktop/src/SidePanel.tsx` | `apps/desktop/test/side-panel-ui.test.tsx`、`apps/desktop/test/panel-host.test.tsx` | `await click('button[aria-label="右侧面板"]'); await click('text=文件'); await waitFor('[aria-label="快速打开"]');` |
| 右侧面板 · 终端 | 右侧面板新标签页点「终端」，或按 ``Ctrl+` `` | `apps/desktop/src/TerminalPane.tsx` | `apps/desktop/test/terminal-session.test.ts`、`apps/desktop/test/terminal-keys.test.ts` | `await click('button[aria-label="右侧面板"]'); await click('text=终端');` |
| 右侧面板 · 浏览器 | 右侧面板新标签页地址栏输入网址并回车 | `apps/desktop/src/BrowserPane.tsx` | `apps/desktop/test/browser-pool.test.ts`、`apps/desktop/test/browser-fullscreen-ui.test.tsx` | `await click('button[aria-label="右侧面板"]'); await waitFor('input[aria-label="地址栏"]');` |
| 右侧面板 · Agent 浏览器 | Agent 打开内置浏览器标签后在右侧面板切换 | `apps/desktop/src/AgentBrowserPane.tsx` | `apps/desktop/test/agent-browser-ui.test.tsx` | `await waitFor('[role="tablist"][aria-label="面板标签"]');` |
| 右侧面板 · 子代理 | 会话概览或对话工具行点子代理条目 | `apps/desktop/src/SubagentPane.tsx` | `apps/desktop/test/subagent-pane.test.tsx`、`apps/desktop/test/subagent-panel-host.test.tsx` | `await click('button[aria-label="会话概览"]'); await waitFor('[aria-label="子代理"]');` |
| 右侧面板 · 后台任务 | 会话概览点后台命令条目 | `apps/desktop/src/ShellPane.tsx`、`apps/desktop/src/ShellRows.tsx` | `apps/desktop/test/shell-overview.test.tsx`、`apps/desktop/test/shell-panel-host.test.tsx` | `await click('button[aria-label="会话概览"]'); await waitFor('.ovpop-shell-open');` |
| 右侧面板 · 合奏 | `/ensemble` 会话中点合奏卡片或概览中的「合奏」 | `apps/desktop/src/EnsemblePane.tsx`、`apps/desktop/src/EnsembleMemberPane.tsx` | `apps/desktop/test/ensemble-pane.test.tsx`、`apps/desktop/test/ensemble-member-session.test.tsx` | `await waitFor('[aria-label="右侧面板"]');` |
| 右侧面板 · 组曲 | 打开组曲指挥会话后点线程条目 | `apps/desktop/src/SuitePane.tsx`、`apps/desktop/src/SuiteThreadPane.tsx` | `apps/desktop/test/suites.test.tsx` | `await waitFor('[aria-label="组曲"]');` |
| 右侧面板 · 插件面板 | 模型调用带界面的插件工具，或点匹配扩展名的文件引用 | `apps/desktop/src/AppPane.tsx`、`apps/desktop/src/SidePanel.tsx` | `apps/desktop/test/mcp-apps.test.tsx` | `await waitFor('iframe.sp-app-frame');` |
| 右侧面板 · Open Artifact | 点击对话中的作品卡或项目页面库中的 Open Artifact 作品 | `apps/desktop/src/ArtifactPane.tsx`、`apps/desktop/src/SidePanel.tsx` | `apps/desktop/test/open-artifact.test.tsx` | `await click('.artifact-entry-row'); await waitFor('.sp-artifact');` |
| 需要 Node.js | 未检测到满足版本的 Node.js 时启动默认显示 | `apps/desktop/src/NodeHelp.tsx` | `apps/desktop/test/node-help.test.tsx` | 触发条件为 Node 探测失败；定位 `.nodecard` |

### 设置区（侧栏底部点「设置」进入 `nav[aria-label="设置"]`）

| 界面名 | 进入方式 | 主组件文件 | 测试文件 | `pnpm shot` 步骤 / CDP 定位 |
|---|---|---|---|---|
| 常规 | 侧栏底部点「设置」默认页，或设置导航「基础设置」组点「常规」 | `apps/desktop/src/SettingsPage.tsx` | `apps/desktop/test/settings.test.tsx` | `await click('text=设置'); await waitFor('nav[aria-label="设置"]'); await waitFor('section[aria-label="常规"]');` |
| 外观 | 设置导航「基础设置」组点「外观」 | `apps/desktop/src/SettingsPage.tsx`、`apps/desktop/src/ThemeCards.tsx`、`apps/desktop/src/AppearancePreview.tsx` | `apps/desktop/test/appearance-page.test.tsx`、`apps/desktop/test/theme-presets.test.ts` | `await click('text=设置'); await click('text=外观'); await waitFor('.theme-strip');` |
| 新建主题 / 编辑主题 / 导入主题 / 导出主题 | 设置 › 外观主题区点新建、编辑、导入或导出 | `apps/desktop/src/CustomThemeDialog.tsx` | `apps/desktop/test/custom-theme.test.tsx` | `await click('text=设置'); await click('text=外观'); await waitFor('[role="dialog"][aria-label="新建主题"]');` |
| 服务商 | 设置导航「基础设置」组点「服务商」 | `apps/desktop/src/ProvidersPage.tsx`、`apps/desktop/src/ModelSettingsDialog.tsx` | `apps/desktop/test/providers.test.tsx`、`apps/desktop/test/provider-toggle.test.tsx` | `await click('text=设置'); await click('text=服务商'); await waitFor('[data-testid="providers-page"]');` |
| 模型 | 设置导航「基础设置」组点「模型」 | `apps/desktop/src/SettingsPage.tsx` | `apps/desktop/test/settings.test.tsx` | `await click('text=设置'); await click('text=模型'); await waitFor('section[aria-label="模型"]');` |
| Git | 设置导航「基础设置」组点「Git」 | `apps/desktop/src/SettingsPage.tsx`、`apps/desktop/src/GitWorktreeSettings.tsx` | `apps/desktop/test/git-worktree-settings.test.tsx` | `await click('text=设置'); await click('text=Git'); await waitFor('section[aria-label="Git"]');` |
| 工作树 | 设置导航「基础设置」组点「工作树」 | `apps/desktop/src/SettingsPage.tsx`、`apps/desktop/src/GitWorktreeSettings.tsx` | `apps/desktop/test/git-worktree-settings.test.tsx` | `await click('text=设置'); await click('text=工作树'); await waitFor('section[aria-label="工作树"]');` |
| 子代理 | 设置导航「Agent 能力」组点「子代理」 | `apps/desktop/src/ExternalAgentsPage.tsx`、`apps/desktop/src/SubagentProfileEditor.tsx` | `apps/desktop/test/external-agents.test.tsx`、`apps/desktop/test/subagent-profiles.test.tsx` | `await click('text=设置'); await click('text=子代理'); await waitFor('.external-agents-page');` |
| 记忆 | 设置导航「Agent 能力」组点「记忆」 | `apps/desktop/src/MemoryPage.tsx` | `apps/desktop/test/memory.test.tsx` | 总览：`await click('text=设置'); await click('text=记忆'); await waitFor('.memory-page');`；项目子页：总览点「其他项目」组里项目行的 `.slist-main` 后 `await waitFor('.memory-page .phead-count')`；删除确认：条目详情页 `await click('button:text-is("删除")'); await waitFor('.dlg');` |
| 技能 | 设置导航「Agent 能力」组点「技能」 | `apps/desktop/src/SkillsPage.tsx` | `apps/desktop/test/skills.test.tsx` | `await click('text=设置'); await click('text=技能'); await waitFor('.skills-page');` |
| MCP | 设置导航「Agent 能力」组点「MCP」 | `apps/desktop/src/McpPage.tsx` | `apps/desktop/test/mcp.test.tsx` | `await click('text=设置'); await click('text=MCP'); await waitFor('.mcp-page');` |
| 插件 | 设置导航「Agent 能力」组点「插件」 | `apps/desktop/src/PluginsPage.tsx` | `apps/desktop/test/plugins.test.tsx` | `await click('text=设置'); await click('text=插件'); await waitFor('.plugins-page');` |
| Hook | 设置导航「Agent 能力」组点「Hook」 | `apps/desktop/src/HooksPage.tsx` | `apps/desktop/test/hooks.test.tsx` | `await click('text=设置'); await click('text=Hook'); await waitFor('.hooks-page');` |
| 浏览器 | 设置导航「连接」组点「浏览器」 | `apps/desktop/src/BrowserSettingsPage.tsx` | `apps/desktop/test/browser-settings.test.tsx` | `await click('text=设置'); await click('text=浏览器'); await waitFor('section[aria-label="浏览器"]');` |
| 电脑操控 | 设置导航「连接」组点「电脑操控」 | `apps/desktop/src/ComputerSettingsPage.tsx` | `apps/desktop/test/computer-settings.test.tsx` | `await click('text=设置'); await click('text=电脑操控'); await waitFor('section[aria-label="电脑操控"]');` |
| 远程 | 设置导航「连接」组点「远程」 | `apps/desktop/src/RemotePage.tsx` | `apps/desktop/test/remote.test.tsx`、`apps/desktop/test/pairing-qr.test.ts` | `await click('text=设置'); await click('text=远程'); await waitFor('text=让手机连到这台电脑');` |
| 授权 | 设置导航「数据与安全」组点「授权」 | `apps/desktop/src/GrantsPage.tsx` | `apps/desktop/test/grants.test.tsx` | `await click('text=设置'); await click('text=授权'); await waitFor('.grants-page');` |
| 已归档的会话 | 设置导航「数据与安全」组点「已归档的会话」 | `apps/desktop/src/ArchivePage.tsx` | `apps/desktop/test/archive-page.test.tsx` | `await click('text=设置'); await click('text=已归档的会话'); await waitFor('section[aria-label="已归档的会话"]');` |
| 用量 | 设置导航「数据与安全」组点「用量」 | `apps/desktop/src/UsagePage.tsx`、`apps/desktop/src/UsageCharts.tsx` | `apps/desktop/test/usage.test.tsx`、`apps/desktop/test/usage-details.test.tsx` | `await click('text=设置'); await click('text=用量'); await waitFor('.usage-body');` |
| 后台日志 | 设置导航「数据与安全」组点「后台日志」 | `apps/desktop/src/BackendLogsPage.tsx` | `apps/desktop/test/app.test.tsx` | `await click('text=设置'); await click('text=后台日志'); await waitFor('[data-testid="logs-page"]');` |

## 手机网页

| 界面名 | 进入方式 | 主组件文件 | 测试文件 |
|---|---|---|---|
| Nocturne（欢迎 / 配对） | 未配对电脑时首次打开中继网页，或扫码带入配对链接 | `apps/desktop/src/web/App.tsx` | `apps/desktop/test/phone-ui.test.tsx`、`apps/desktop/test/phone.test.ts` |
| 项目 | 已配对电脑时的首页 | `apps/desktop/src/web/App.tsx` | `apps/desktop/test/phone-ui.test.tsx`、`apps/desktop/test/phone-shell.test.tsx` |
| 项目会话列表 | 首页点任意项目行 | `apps/desktop/src/web/App.tsx`、`apps/desktop/src/web/SessionScreen.tsx` | `apps/desktop/test/phone-ui.test.tsx`、`apps/desktop/test/phone-archive.test.ts` |
| 会话 | 项目会话列表点任意会话行，或在项目页底部直接发送 | `apps/desktop/src/web/SessionScreen.tsx`、`apps/desktop/src/web/PhoneComposer.tsx`、`apps/desktop/src/web/SessionHeaderTools.tsx` | `apps/desktop/test/phone-session-ui.test.tsx`、`apps/desktop/test/phone-composer.test.tsx`、`apps/desktop/test/session-screen-send.test.tsx` |
| 侧边栏（上下文 / 变更 / 文件 / 子代理 / 后台任务） | 会话页顶栏右侧点「侧边栏」按钮 | `apps/desktop/src/web/PhoneSidePanel.tsx`、`apps/desktop/src/web/PhoneTasks.tsx` | `apps/desktop/test/phone-side-panel.test.tsx`、`apps/desktop/test/phone-todos.test.tsx` |
| 定时任务 | 首页点「定时任务」 | `apps/desktop/src/SchedulePage.tsx`、`apps/desktop/src/web/App.tsx` | `apps/desktop/test/schedule-page.test.tsx` |
| 组曲 | 首页点「组曲」 | `apps/desktop/src/SuitesPage.tsx`、`apps/desktop/src/web/App.tsx` | `apps/desktop/test/phone-suites.test.tsx` |
| 合奏 | 侧边栏「合奏」入口或 `/ensemble board` | `apps/desktop/src/EnsemblePane.tsx`、`apps/desktop/src/web/App.tsx` | `apps/desktop/test/phone-ensemble.test.tsx` |
| 设置 | 首页顶栏右侧点「设置」按钮 | `apps/desktop/src/web/App.tsx` | `apps/desktop/test/phone-ui.test.tsx`、`apps/desktop/test/appearance-phone.test.tsx` |
| 连接诊断 | 设置页点「连接诊断」 | `apps/desktop/src/web/App.tsx` | `apps/desktop/test/phone-ui.test.tsx` |
| 授权 | 设置页点「授权」 | `apps/desktop/src/GrantsPage.tsx`、`apps/desktop/src/web/App.tsx` | `apps/desktop/test/grants.test.tsx` |
| 用量 | 设置页点「用量」 | `apps/desktop/src/UsagePage.tsx`、`apps/desktop/src/web/App.tsx` | `apps/desktop/test/usage.test.tsx` |

## TUI

| 界面名 | 进入方式 | 主组件文件 | 测试文件 |
|---|---|---|---|
| 主对话（含欢迎区、消息流、输入栏与状态栏） | 终端运行 `nctrn`（TTY 默认进入） | `apps/tui/src/app.tsx`、`apps/tui/src/components/transcript.tsx`、`apps/tui/src/components/composer.tsx`、`apps/tui/src/components/status-bar.tsx` | `apps/tui/test/app.test.tsx`、`apps/tui/test/fullscreen-ui.test.tsx`、`apps/tui/test/welcome.test.tsx` |
| 设置 | 输入 `/settings` | `apps/tui/src/components/settings-page.tsx`、`apps/tui/src/components/compaction-threshold-dialog.tsx`、`apps/tui/src/components/reviewer-dialog.tsx` | `apps/tui/test/settings-page.test.tsx`、`apps/tui/test/reviewer-dialog.test.tsx`、`apps/tui/test/model-roles.test.tsx` |
| 模型 | 输入 `/model` | `apps/tui/src/components/model-picker.tsx` | `apps/tui/test/model-picker.test.tsx` |
| 服务商 | 输入 `/provider` | `apps/tui/src/components/provider-page.tsx`、`apps/tui/src/components/provider-dialog.tsx`、`apps/tui/src/components/model-settings-view.tsx` | `apps/tui/test/provider-app.test.tsx`、`apps/tui/test/model-settings.test.tsx`、`apps/tui/test/provider-toggle-ui.test.tsx` |
| 主题 | 输入 `/theme`，或在设置页进入「主题」 | `apps/tui/src/components/theme-page.tsx` | `apps/tui/test/theme-page.test.tsx`、`apps/tui/test/theme.test.tsx` |
| 授权 | 输入 `/grants` | `apps/tui/src/components/grants-page.tsx` | `apps/tui/test/grants-page.test.tsx` |
| 回退 | 输入 `/rewind` | `apps/tui/src/components/rewind-page.tsx` | `apps/tui/test/rewind-page.test.tsx`、`apps/tui/test/rewind-app.test.tsx` |
| 切换到会话（当前目录） | 输入 `/resume` | `apps/tui/src/components/pick-list.tsx`、`apps/tui/src/app.tsx` | `apps/tui/test/app.test.tsx`、`apps/tui/test/pick-list.test.tsx` |
| 搜索会话 | 输入 `/search` | `apps/tui/src/components/session-search.tsx` | `apps/tui/test/session-search.test.tsx` |
| 后台子代理 | 输入 `/subagents` | `apps/tui/src/components/subagents.tsx` | `apps/tui/test/background-subagents.test.tsx` |
| 后台任务 | 输入 `/tasks` | `apps/tui/src/components/tasks.tsx` | `apps/tui/test/background-shell.test.tsx` |
| 合奏 | 输入 `/ensemble board` | `apps/tui/src/components/ensemble-board.tsx`、`apps/tui/src/components/ensemble-strip.tsx` | `apps/tui/test/ensemble-ui.test.tsx` |
| 组曲 | 输入 `/suite` 或 `/suite overview` | `apps/tui/src/components/suite-overview.tsx`、`apps/tui/src/components/suite-strip.tsx` | `apps/tui/test/suite-ui.test.tsx` |
| 添加服务商向导 | 首次无配置启动或 `/provider add` | `apps/tui/src/components/wizard-view.tsx` | `apps/tui/test/wizard.test.tsx`、`apps/tui/test/provider-login.test.tsx` |
| 需要确认 | 工具调用触发权限确认时弹出 | `apps/tui/src/components/permission-dialog.tsx` | `apps/tui/test/subagent-permission.test.tsx`、`apps/tui/test/schedule-permission.test.tsx` |
| 提问 | 工具调用 `ask_user` 时弹出 | `apps/tui/src/components/question-dialog.tsx` | `apps/tui/test/question.test.tsx`、`apps/tui/test/question-layout.test.tsx` |
