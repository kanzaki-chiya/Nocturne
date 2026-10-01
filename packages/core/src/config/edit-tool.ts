/**
 * 编辑工具的内置默认表（ADR-0035 §5）：纯数据函数，config 层持有、
 * 由装配处注入 provider 的模型解析；用户编辑与手写配置覆盖其结果。
 */
import type { EditToolKind } from "../protocol/index.js";

/**
 * 按模型 ID 匹配默认编辑工具：去掉 `provider/` 前缀后的最后一段
 * （不区分大小写）名字里含 gpt 或 codex → "apply_patch"，其余 "edit"。
 * 放宽到所有含 gpt 的名字是因为 GPT 新型号命名变化快（gpt-6.1-sol、
 * gpt-6-astra）；gpt-4o/gpt-3.5 这类旧模型可能 edit 更稳，需要时由
 * 用户在模型编辑页改回。
 */
export function defaultEditToolForModel(modelId: string): EditToolKind {
  const last = (modelId.split("/").at(-1) ?? modelId).toLowerCase();
  return last.includes("gpt") || last.includes("codex") ? "apply_patch" : "edit";
}
