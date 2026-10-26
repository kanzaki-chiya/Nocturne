import type { Runtime, RuntimeConfig, RuntimeSession } from "@nocturne/core";
import type { Grant } from "@nocturne/core/protocol";

export function grantLines(entries: readonly { grant: Grant; scope: string }[]): string[] {
  return entries.length === 0
    ? ["还没有授权。"]
    : entries.map(
        ({ grant, scope }, i) =>
          `${i + 1}. [${scope}] ${grant.kind}  ${grant.target}  ${grant.createdAt}`,
      );
}
export async function projectGrants(
  config: RuntimeConfig,
  workspace: string,
  action: "list" | "revoke",
  index?: number,
  all = false,
): Promise<string> {
  const store = (await config.forWorkspace(workspace)).grants;
  const entries = store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (action === "list")
    return [
      `项目授权：${workspace}`,
      ...grantLines(entries.map((grant) => ({ grant, scope: "本项目" }))),
    ].join("\n");
  if (all) await store.clear();
  else {
    const grant = entries[(index ?? 0) - 1];
    if (!grant) throw new Error("授权编号不存在；先运行 nctrn grants list 查看。");
    await store.remove(grant.kind, grant.target);
  }
  return "已撤销，下一次调用会重新询问。";
}
export async function sessionGrants(
  runtime: Runtime,
  session: RuntimeSession,
  args: string[],
): Promise<string> {
  const workspace = session.state().meta.workspaceRoot;
  const entries = [
    ...session.listGrants().map((grant) => ({ grant, scope: "本会话" })),
    ...(await runtime.listGrants({ workspace })).map((grant) => ({ grant, scope: "本项目" })),
  ];
  if (args.length === 0) return ["授权：", ...grantLines(entries)].join("\n");
  if (args.length !== 2 || args[0] !== "revoke" || !/^[1-9]\d*$/.test(args[1] ?? ""))
    return "用法：/grants [revoke <编号>]";
  const entry = entries[Number(args[1]) - 1];
  if (!entry) return "授权编号不存在；先用 /grants 查看。";
  const { kind, target } = entry.grant;
  if (entry.scope === "本会话") await session.revokeGrant({ kind, target });
  else await runtime.revokeGrant({ workspace, kind, target });
  return "已撤销，下一次调用会重新询问。";
}
