/** Local Git branches visible to a workspace. A worktree path marks a branch occupied elsewhere. */
export interface WorkspaceBranch {
  name: string;
  worktree?: string;
}

export interface WorkspaceBranches {
  current: string | null;
  branches: WorkspaceBranch[];
  busy: boolean;
}
