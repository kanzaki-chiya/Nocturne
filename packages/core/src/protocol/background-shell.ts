export interface BackgroundShellTask {
  taskId: string;
  callId: string;
  name: string;
  command: string;
  logPath: string;
  status: "running" | "exited" | "timeout" | "killed" | "interrupted";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
}
