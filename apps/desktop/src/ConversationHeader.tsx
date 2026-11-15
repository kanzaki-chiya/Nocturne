import type { ReactNode } from "react";
import type { ApplicationTarget } from "@nocturne/core/protocol";
import { Button } from "./ui";

export function ConversationHeader({
  title,
  workspace,
  branch,
  computerActive,
  onStopComputer,
}: {
  title: string;
  workspace: string;
  branch: ReactNode;
  computerActive?: ApplicationTarget | undefined;
  onStopComputer?: (() => void) | undefined;
}) {
  return (
    <div className="head">
      <span className="conversation-title" title={workspace}>
        {title}
      </span>
      {branch}
      <span className="sp" />
      {computerActive && (
        <span className="head-computer">
          <span>{computerActive.name ?? computerActive.identity ?? "电脑操控"}</span>
          {onStopComputer && (
            <Button size="sm" variant="ghost" onClick={onStopComputer}>
              停止
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
