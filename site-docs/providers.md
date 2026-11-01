# 连接服务商

## 打开配置入口

- **桌面端**：点击左侧边栏底部的「设置」（快捷键 `Ctrl+,` / `⌘,`），默认打开「服务商」页面。
- **终端 TUI**：输入 `/provider` 打开服务商管理页，或在启动时运行 `nocturne --setup` 打开交互式配置向导。

## 内置服务商预设

在桌面端「设置 → 服务商」左侧列表的「可添加」分组中，包含以下内置服务商预设：

| 预设名称 | 默认 ID | 协议类型 | 认证方式与默认环境变量 |
| --- | --- | --- | --- |
| Magpie（免费） | `magpie` | OpenAI / Anthropic | 免配置自动注册（可在「设置 → 通用 → Magpie 免费体验」开关），默认提供 `claude-opus-4.6`、`gpt-6-sol`、`deepseek-v4.1-flash` |
| ChatGPT (Plus / Pro) | `chatgpt` | `chatgpt` | 点击「登录 ChatGPT」通过浏览器 OAuth 登录，或点击「从 Codex CLI 导入」读取 `~/.codex/auth.json` |
| Claude (Pro / Max) | `claude` | `anthropic` | 点击「从 Claude Code 导入」读取本机 `~/.claude/.credentials.json`（运行 `claude login` 刷新） |
| Anthropic (API Key) | `anthropic` | `anthropic` | API Key / `ANTHROPIC_API_KEY` |
| OpenAI (API Key) | `openai` | `openai-compatible` | API Key / `OPENAI_API_KEY` |
| DeepSeek | `deepseek` | `openai-compatible` | API Key / `DEEPSEEK_API_KEY` |
| OpenRouter | `openrouter` | `openai-compatible` | 点击「浏览器登录」完成 OAuth PKCE 授权，或填写 API Key / `OPENROUTER_API_KEY` |
| Ollama（本地） | `ollama` | `openai-compatible` | 本地免密或填写环境变量（默认地址 `http://localhost:11434/v1`） |

### 凭据存储方式

填写 API Key 时可选择两种保存方式：

- **直接输入（加密保存）**：密钥保存在系统凭据存储（Windows DPAPI、macOS Keychain、Linux `secret-tool` 保护下的 `~/.nocturne/credentials.json`），`config.json` 中不写明文。
- **从环境变量读取**：配置文件只记录环境变量名（如 `OPENAI_API_KEY`），运行时从进程环境读取。

## 自定义服务商（OpenAI / Anthropic 兼容）

接入自建网关、vLLM、LM Studio 或其他第三方服务时：

1. 在桌面端「设置 → 服务商」左侧列表底部点击「添加自定义服务商」。
2. 填写「名称」（如 `my-gateway`），选择「协议」（`OpenAI 兼容（Chat Completions）`、`OpenAI Responses` 或 `Anthropic Messages`），填写「接口地址」（`baseURL`）。
3. 选择「认证方式」（`API 密钥`、`自定义请求头` 或 `无需认证`）并填写凭据。
4. 点击「获取模型列表」自动拉取远端模型，或点击「手动输入」填写模型 ID，再点击「添加服务商」保存。
5. 保存后可在服务商详情页右上角点击「测试连接」验证接口是否可用，或点击「刷新模型」同步最新模型列表。

对应的配置文件字段说明见 [配置参考](config.md)。

## 切换模型与推理强度

### 当前会话切换

- **桌面端**：点击输入框底部左侧的模型按钮（快捷键 `Ctrl+M` / `⌘M`）选择模型；当所选模型支持推理时，右侧会显示推理强度选择器（`关闭` / `低` / `中` / `高` / `最高`）。
- **终端 TUI**：输入 `/model` 打开模型选择器（或 `/model <provider/model>` 直接切换）；输入 `/effort` 或按 `Ctrl+T` 循环切换推理强度。

### 设为默认与单模型设置

- 在桌面端「设置 → 服务商」的模型列表中，点击任意模型行右侧的「设为默认」可将其设为新会话的默认模型；也可在「设置 → 通用 → 默认推理强度」中设置全局默认推理档位。
- 点击模型行右侧的「设置」按钮打开「模型设置」弹窗，可修改该模型的「显示名称」、「上下文窗口（tokens）」、「最大输出（tokens）」、「思考模式」以及每百万 Token 的输入/输出价格。
