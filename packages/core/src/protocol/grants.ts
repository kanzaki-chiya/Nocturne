/** 授权管理（ADR-0068）；用户操作入口，不注册成工具。 */
export interface GrantWorkspace {
  workspace: string;
  grantCount: number;
  trusted: boolean;
  hasProjectConfig: boolean;
}

export interface ProjectTrustDescription {
  mcpServers: { name: string; command: string }[];
  hooks: { event: string; count: number }[];
  relaxedRuleCount: number;
}

export interface GrantsChangedPayload {
  workspace?: string | undefined;
  sessionId?: string | undefined;
}
