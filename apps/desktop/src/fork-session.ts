import type { RewindTarget } from "@nocturne/core/protocol";

/**
 * 分叉后放进新会话输入框的文字：与 `/rewind` 回填同源（`RewindTarget.text`），
 * 执行方式消息带命令名，Runtime 写入的消息为空串。读不到时也为空串，不阻止分叉。
 */
export async function forkDraftText(
  source: { rewindTargets: () => Promise<readonly RewindTarget[]> },
  targetSeq: number,
): Promise<string> {
  try {
    return (await source.rewindTargets()).find((item) => item.seq === targetSeq)?.text ?? "";
  } catch {
    return "";
  }
}

/**
 * 从当前会话的一条用户消息处分叉，然后打开新会话并刷新列表。
 * `selectSession` 与侧栏点选同一条路径：选中、打开、refresh。
 * 原消息文字在打开前交给 `onDraft`，由新会话的输入框取用一次。
 */
export async function openForkedSession(
  active: {
    sessionId: string;
    workspace: string;
    forkSession: (sessionId: string, targetSeq: number) => Promise<string>;
    rewindTargets: () => Promise<readonly RewindTarget[]>;
  },
  targetSeq: number,
  selectSession: (id: string, workspace: string) => Promise<void>,
  onDraft: (id: string, text: string) => void,
): Promise<string> {
  const text = await forkDraftText(active, targetSeq);
  const id = await active.forkSession(active.sessionId, targetSeq);
  if (text !== "") onDraft(id, text);
  await selectSession(id, active.workspace);
  return id;
}
