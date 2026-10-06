import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PathOps, SubjectRequest } from "@nocturne/core";

/** ADR-0049 的封闭映射；未知操作不交给权限 gate。 */
export function permissionSubjects(
  call: RequestPermissionRequest["toolCall"],
  cwd: string,
  paths: PathOps,
): SubjectRequest[] | undefined {
  let kind: SubjectRequest["kind"];
  switch (call.kind) {
    case "read":
    case "search":
      kind = "read";
      break;
    case "edit":
    case "delete":
    case "move":
      kind = "edit";
      break;
    case "execute":
      return [{ kind: "shell", target: "*" }];
    case "fetch":
      return [{ kind: "network", target: "*" }];
    default:
      return undefined;
  }
  const targets = [
    ...new Set(call.locations?.map((location) => location.path).filter(Boolean) ?? []),
  ];
  return targets.length > 0
    ? targets.map((target) => ({ kind, target: paths.resolve(cwd, target) }))
    : [{ kind, target: "*" }];
}

/** 授权只能单次；对方未提供单次授权或拒绝时，失败关闭。 */
export function permissionOutcome(
  options: RequestPermissionRequest["options"],
  allowed: boolean,
): { response: RequestPermissionResponse; allowed: boolean } {
  const option = allowed ? options.find((item) => item.kind === "allow_once") : undefined;
  const selected = option ?? options.find((item) => item.kind === "reject_once");
  return {
    response: {
      outcome: selected
        ? { outcome: "selected", optionId: selected.optionId }
        : { outcome: "cancelled" },
    },
    allowed: option !== undefined,
  };
}
