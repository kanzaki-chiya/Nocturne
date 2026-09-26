/**
 * 全屏帧预算（ADR-0020）：帧高始终等于终端行数减 1。
 * 帧高一旦大于或等于终端行数，Ink 会整屏清空。
 * 终端太矮时先减少候选行数，再压缩对话区，总和不得超过帧高。
 */
export interface FrameBudget {
  /** 始终等于 max(0, rows - 1) */
  frameHeight: number;
  conversation: number;
  /** 输入框上方分隔线，空间不够时先于输入行丢掉 */
  inputRule: number;
  input: number;
  completion: number;
  status: number;
}

/**
 * @param rows 终端行数
 * @param completionWanted 希望显示的候选行数（已截到 0–8 之外也会被截断）
 */
export function frameBudget(rows: number, completionWanted: number): FrameBudget {
  const frameHeight = Math.max(0, rows - 1);
  const status = frameHeight >= 1 ? 1 : 0;
  const input = frameHeight >= 2 ? 1 : 0;
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
  return { frameHeight, conversation, inputRule, input, completion, status };
}
