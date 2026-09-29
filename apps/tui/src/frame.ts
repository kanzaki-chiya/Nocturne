/**
 * 活动区预算（ADR-0021）：高度至多终端行数减 1。
 * 达到终端行数时 Ink 会整屏清空；太矮时先减候选，再压缩对话区。
 */
export interface FrameBudget {
  /** 活动区上限 max(0, rows - 1)，实际高度可更小 */
  frameHeight: number;
  conversation: number;
  /** 输入框上方分隔线，空间不够时先于输入行丢掉 */
  inputRule: number;
  input: number;
  completion: number;
  todo: number;
  status: number;
}

/**
 * @param rows 终端行数
 * @param completionWanted 希望显示的候选行数（已截到 0–8 之外也会被截断）
 */
export function frameBudget(
  rows: number,
  completionWanted: number,
  inputWanted = 1,
  todoWanted = 0,
): FrameBudget {
  const frameHeight = Math.max(0, rows - 1);
  const status = frameHeight >= 1 ? 1 : 0;
  const input = frameHeight >= 2 ? Math.min(5, Math.max(1, inputWanted), frameHeight - status) : 0;
  // 分隔线是输入框的一部分。帧高只够状态+输入时不画线，把行留给对话。
  const afterChrome = frameHeight - status - input;
  const inputRule = afterChrome >= 2 ? 1 : 0;
  const remaining = frameHeight - status - input - inputRule;
  const wanted = Math.min(8, Math.max(0, Math.floor(completionWanted)));
  let conversation = 0;
  let completion = 0;
  if (remaining > 0) {
    // 先保住 1 行对话，候选只拿剩余；剩余不够时候选先减到 0，对话再被压到 0。
    conversation = 1;
    const surplus = remaining - 1;
    completion = Math.min(wanted, surplus);
    conversation += surplus - completion;
  }
  const todo = Math.min(Math.max(0, todoWanted), Math.max(0, conversation - 3));
  conversation -= todo;
  return { frameHeight, conversation, inputRule, input, completion, todo, status };
}
