/**
 * 设置区「后台日志」页：查看常驻后台与外壳自身的 stderr 内存缓冲
 * （ADR-0051 后只有一个 nctrn 后台，选择器只有「后台」「外壳」两项）。
 * 只在打开页面、切换条目或点「刷新」时经 backend_stderr/shell_log 拉取，
 * 不轮询；缓冲只在内存里保留（最近 500 行、每行不超过 64 KiB），不写盘。
 * 已退出后台的缓冲随进程回收，其尾部日志由崩溃横幅里的 closed.stderr 携带。
 */
import { useEffect, useRef, useState } from "react";

import { Dropdown } from "./Dropdown";

/** 「外壳」日志项的伪 backendId（不存在这样的后台，调用方按此值改走 shell_log） */
export const SHELL_LOG_ID = -1;

/** 日志页的一个可选后台 */
export interface BackendLogTarget {
  /** backend_stderr 命令的参数；SHELL_LOG_ID 表示外壳自身日志（走 shell_log 命令） */
  backendId: number;
  /** 项目名或「对话（常驻）」「外壳」 */
  label: string;
  /** 工作区路径（选项里的说明行） */
  detail: string;
}

/** Tauri 命令拒绝的是 CommandError { code, message } 对象，不一定是 Error 实例 */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { message?: unknown }).message === "string"
  ) {
    return (e as { message: string }).message;
  }
  return String(e);
}

export function BackendLogsPage({
  backends,
  fetchStderr,
}: {
  backends: BackendLogTarget[];
  fetchStderr: (backendId: number) => Promise<string[]>;
}) {
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  // 后台退出或新增后列表会变：选中项不在了就回落到第一个
  const current = backends.find((b) => String(b.backendId) === picked) ?? backends[0];

  const load = async (target: BackendLogTarget) => {
    setLoading(true);
    try {
      setLines(await fetchStderr(target.backendId));
      setError(null);
    } catch (e) {
      setLines(null);
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };

  // 只在打开页面或切换后台时拉取；进程侧缓存在内存里，不持久化
  const currentId = current?.backendId;
  useEffect(() => {
    setLines(null);
    setError(null);
    const target = backends.find((b) => b.backendId === currentId);
    if (target !== undefined) void load(target);
    // 依赖只挂 backendId：load 只随目标变化；backends 数组身份每次渲染都变
  }, [currentId]);

  useEffect(
    () => () => {
      window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyAll = () => {
    if (lines === null || lines.length === 0) return;
    navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => {
        setCopied(true);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => undefined); // 剪贴板不可用时日志仍完整显示，可手动复制
  };

  return (
    <section className="page3" data-testid="logs-page" aria-label="后台日志">
      <div className="ph3">
        <div className="grow">
          <h3>后台日志</h3>
          <span className="sub">后台进程 stderr 的内存缓冲（最近 500 行），不写盘、不轮询</span>
        </div>
        <Dropdown
          label="后台"
          value={current === undefined ? undefined : String(current.backendId)}
          options={backends.map((b) => ({
            value: String(b.backendId),
            label: b.label,
            description: b.detail,
          }))}
          onChange={setPicked}
          placeholder="没有运行中的后台"
          {...(backends.length === 0 ? { disabled: "当前没有运行中的后台" } : {})}
        />
        <button
          className="btn"
          disabled={current === undefined || loading}
          onClick={() => {
            if (current !== undefined) void load(current);
          }}
        >
          {loading ? "读取中…" : "刷新"}
        </button>
        <button className="btn" disabled={lines === null || lines.length === 0} onClick={copyAll}>
          {copied ? "已复制" : "复制全部"}
        </button>
      </div>
      <div className="logpage">
        {backends.length === 0 && (
          <div className="logempty">当前没有运行中的后台，打开一个会话后再来看。</div>
        )}
        {error !== null && <div className="logerr">{error}</div>}
        {current !== undefined && lines !== null && lines.length === 0 && error === null && (
          <div className="logempty">
            {current.backendId === SHELL_LOG_ID
              ? "外壳暂无诊断输出。"
              : "该后台暂无 stderr 输出；已退出后台的最后几行日志显示在崩溃横幅里。"}
          </div>
        )}
        {lines !== null && lines.length > 0 && <pre className="logview">{lines.join("\n")}</pre>}
      </div>
    </section>
  );
}
