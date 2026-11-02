/**
 * 从当前会话的一条用户消息处分叉，然后打开新会话并刷新列表。
 * `selectSession` 与侧栏点选同一条路径：选中、打开、refresh。
 */
export async function openForkedSession(
  active: {
    sessionId: string;
    workspace: string;
    forkSession: (sessionId: string, targetSeq: number) => Promise<string>;
  },
  targetSeq: number,
  selectSession: (id: string, workspace: string) => Promise<void>,
): Promise<string> {
  const id = await active.forkSession(active.sessionId, targetSeq);
  await selectSession(id, active.workspace);
  return id;
}
