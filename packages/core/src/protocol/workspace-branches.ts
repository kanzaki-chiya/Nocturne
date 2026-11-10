/** Local Git branches visible to a workspace. A worktree path marks a branch occupied elsewhere. */
export interface WorkspaceBranch {
  name: string;
  worktree?: string;
}

export interface WorkspaceBranches {
  current: string | null;
  branches: WorkspaceBranch[];
  busy: boolean;
  /** 新建分支基准（ADR-0085）：依次取 main、origin/HEAD、master，取不到时为 null */
  defaultBranch?: string | null | undefined;
}
