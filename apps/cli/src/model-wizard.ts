/**
 * /provider model <服务商> <模型> 的行式问答（ADR-0024 第 4 节）：
 * 逐字段显示"当前值（来源）"，回车保留、`-` 清除用户编辑；只读字段
 * （来源为 config 或推理 none 锁定的档位）只显示不提问。收集完一次性
 * saveModelSettings——校验失败打印原因且不写文件。
 * 只依赖 Core 的 listModelSettings / saveModelSettings，不含 Core 编排。
 */
import {
  isReasoningEffortLevel,
  modelFieldSourceText,
  REASONING_EFFORT_LEVELS,
  type ModelSettingsPatch,
  type RuntimeConfig,
} from "@nocturne/core";
import type { SetupPrompts } from "@nocturne/tui/provider-prompts";

const MODEL_FIELD_LABELS = {
  displayName: "显示名",
  contextWindow: "上下文长度",
  maxOutputTokens: "最大输出",
  reasoning: "推理",
  imageInput: "图片输入",
  reasoningEffort: "思考档位",
  // ADR-0026 第 7 节：第七个字段「协议」
  protocol: "协议",
  // ADR-0035 §5：第八个字段「编辑工具」
  editTool: "编辑工具",
} as const;
type ModelFieldKey = keyof typeof MODEL_FIELD_LABELS;
const MODEL_FIELD_ORDER: readonly ModelFieldKey[] = [
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "imageInput",
  "reasoningEffort",
  "protocol",
  "editTool",
];

/** 当前值的一行显示（用户未声明时显示生效值；未声明显示 "—"） */
function modelFieldText(key: ModelFieldKey, value: unknown): string {
  if (value === undefined) return key === "protocol" ? "协议不支持" : "—";
  if (key === "reasoning") return value === "none" ? "否" : "是";
  if (key === "imageInput") return value === true ? "是" : "否";
  if (key === "reasoningEffort")
    return Array.isArray(value) ? (value.length > 0 ? value.join(",") : "不支持") : "—";
  if (key === "protocol") {
    if (value === "openai-compatible") return "Chat Completions";
    if (value === "anthropic") return "Messages";
    if (value === "openai-responses") return "Responses";
    return "—";
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "—";
}

function parseModelField(key: ModelFieldKey, input: string): unknown {
  const s = input.trim();
  if (s === "") return "";
  switch (key) {
    case "displayName":
      return s;
    case "contextWindow":
    case "maxOutputTokens": {
      const n = Number(s);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
    case "imageInput": {
      const t = s.toLowerCase();
      if (t === "y" || t === "yes" || t === "true" || t === "on") return true;
      if (t === "n" || t === "no" || t === "false" || t === "off") return false;
      return undefined;
    }
    case "reasoning":
      return s.toLowerCase() === "y" ? "visible" : s.toLowerCase() === "n" ? "none" : undefined;
    case "reasoningEffort": {
      if (s.toLowerCase() === "none") return [];
      const levels = s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== "");
      return levels.length > 0 && levels.every(isReasoningEffortLevel) ? levels : undefined;
    }
    case "protocol": {
      // ADR-0026 第 7 节：CLI 输入 chat / messages / responses；- 在调用方处理
      const t = s.toLowerCase();
      if (t === "chat") return "openai-compatible";
      if (t === "messages") return "anthropic";
      if (t === "responses") return "openai-responses";
      return undefined;
    }
    case "editTool": {
      // ADR-0035 §5：CLI 输入 edit / patch（apply_patch 的短写）
      const t = s.toLowerCase();
      if (t === "edit") return "edit";
      if (t === "patch" || t === "apply_patch") return "apply_patch";
      return undefined;
    }
  }
}

export async function runProviderModelWizard(
  io: Pick<SetupPrompts, "ask" | "print">,
  config: RuntimeConfig,
  providerId: string,
  modelId: string,
  opts?: { workspaceRoot?: string | undefined },
): Promise<void> {
  const views = await config.listModelSettings(providerId, opts?.workspaceRoot);
  const view = views.find((v) => v.modelId === modelId);
  if (view === undefined) {
    io.print(`! 模型 "${modelId}" 不在服务商 "${providerId}" 的清单中`);
    return;
  }
  io.print(`编辑 ${providerId}/${modelId}（回车保留，- 清除用户编辑）`);
  if (view.readonly) {
    if (view.readonlyHint !== undefined) io.print(`! ${view.readonlyHint}`);
    for (const key of MODEL_FIELD_ORDER) {
      if (key === "reasoningEffort" && view.fields.reasoning.value === "none") continue;
      const f = view.fields[key];
      io.print(
        `  ${MODEL_FIELD_LABELS[key]}：${modelFieldText(key, f.value)}（${modelFieldSourceText(f.source, key)}）`,
      );
    }
    return;
  }
  const patch: ModelSettingsPatch = {};
  for (const key of MODEL_FIELD_ORDER) {
    const effectiveReasoning =
      patch.reasoning === null
        ? view.fields.reasoning.lowerValue
        : (patch.reasoning ?? view.fields.reasoning.value);
    if (key === "reasoningEffort" && effectiveReasoning === "none") continue;
    const f = view.fields[key];
    const shown = `${modelFieldText(key, f.userValue ?? f.value)}（${modelFieldSourceText(f.source, key)}）`;
    if (!f.editable) {
      io.print(`  ${MODEL_FIELD_LABELS[key]}：${shown}`);
      continue;
    }
    const answer = await io.ask(`  ${MODEL_FIELD_LABELS[key]} [${shown}]：`, {
      hint:
        key === "displayName"
          ? "留空 = 跟随下层值"
          : key === "imageInput"
            ? "y / n；- 清除用户编辑"
            : key === "reasoning"
              ? "y = 是 / n = 否；- 清除用户编辑"
              : key === "reasoningEffort"
                ? `逗号分隔（${REASONING_EFFORT_LEVELS.join(",")}）或 none = 不支持；- 清除用户编辑`
                : key === "protocol"
                  ? "chat / messages / responses；- 清除用户编辑（跟随）"
                  : key === "editTool"
                    ? "edit = edit+write / patch = apply_patch；- 清除用户编辑"
                    : "正整数；- 清除用户编辑",
    });
    const t = answer.trim();
    if (t === "") continue;
    if (t === "-") {
      patch[key] = null;
      continue;
    }
    const parsed = parseModelField(key, t);
    if (parsed === undefined || parsed === "") {
      io.print(`! ${MODEL_FIELD_LABELS[key]} 的值 "${t}" 无效，未写入`);
      return;
    }
    (patch as Record<string, unknown>)[key] = parsed;
  }
  try {
    await config.saveModelSettings(providerId, modelId, patch, opts?.workspaceRoot);
  } catch (e) {
    io.print(`! 保存失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  io.print(`已保存 ${providerId}/${modelId}`);
}
