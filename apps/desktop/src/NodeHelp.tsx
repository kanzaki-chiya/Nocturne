import type { NodeProbe, NodeSource } from "./types";

export interface NodeHelpProps {
  probe: NodeProbe;
  /** 重新检测进行中（按钮禁用） */
  checking: boolean;
  onProbe: () => void;
  openUrl: (url: string) => void;
}

function stepOf(probe: NodeProbe, source: NodeSource) {
  return probe.steps.find((s) => s.source === source);
}

interface Row {
  label: string;
  text: string;
  cls?: "bad" | "dim";
}

/** `.probe` 四行：NOCTURNE_NODE / 随附 Node / PATH / 版本 */
export function probeRows(probe: NodeProbe): Row[] {
  const rows: Row[] = [];

  const env = stepOf(probe, "env");
  if (env?.status === "missing") {
    rows.push({ label: "NOCTURNE_NODE", text: `${env.path ?? ""}（文件不存在）`, cls: "bad" });
  } else if (env?.status === "found") {
    rows.push({ label: "NOCTURNE_NODE", text: env.path ?? "" });
  } else {
    rows.push({ label: "NOCTURNE_NODE", text: "未设置", cls: "dim" });
  }

  const bundled = stepOf(probe, "bundled");
  if (bundled?.status === "found") {
    rows.push({ label: "随附 Node", text: bundled.path ?? "" });
  } else if (bundled?.status === "skipped") {
    rows.push({ label: "随附 Node", text: "未检查", cls: "dim" });
  } else {
    rows.push({ label: "随附 Node", text: "此版本不随附", cls: "dim" });
  }

  const path = stepOf(probe, "path");
  if (path?.status === "found") {
    rows.push({ label: "PATH", text: path.path ?? "" });
  } else if (path?.status === "skipped") {
    const via = probe.selected?.source === "env" ? "（已使用 NOCTURNE_NODE）" : "";
    rows.push({ label: "PATH", text: `未检查${via}`, cls: "dim" });
  } else {
    rows.push({ label: "PATH", text: "未找到", cls: "dim" });
  }

  const selected = probe.selected;
  if (selected === null) {
    rows.push({ label: "版本", text: "—", cls: "dim" });
  } else if (selected.error !== null) {
    rows.push({ label: "版本", text: selected.error, cls: "bad" });
  } else if (selected.version !== null && !probe.ok) {
    rows.push({
      label: "版本",
      text: `${selected.version}，需要 ≥ ${probe.required}`,
      cls: "bad",
    });
  } else if (selected.version !== null) {
    rows.push({ label: "版本", text: selected.version });
  } else {
    rows.push({ label: "版本", text: "—", cls: "dim" });
  }

  return rows;
}

function leadText(probe: NodeProbe): string {
  const base = "Nocturne 的后台运行在 Node.js 上。";
  const selected = probe.selected;
  if (selected === null) {
    return `${base}没有找到 Node.js，后台没有启动。`;
  }
  if (selected.error !== null) {
    return `${base}无法运行找到的 Node.js，后台没有启动。`;
  }
  return `${base}当前找到的版本太旧，后台没有启动。`;
}

/** 「24.14.0」→「24.14」 */
function shortRequired(required: string): string {
  const parts = required.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : required;
}

export function NodeHelp({ probe, checking, onProbe, openUrl }: NodeHelpProps) {
  return (
    <div className="center">
      <div className="nodecard">
        <svg width="36" height="36" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10.5 1.5a6.5 6.5 0 1 0 4 11.6A7 7 0 0 1 10.5 1.5z" fill="var(--a-accent)" />
        </svg>
        <h3>需要 Node.js {shortRequired(probe.required)} 或更高版本</h3>
        <div className="lead">{leadText(probe)}</div>
        <dl className="probe" style={{ margin: 0 }}>
          {probeRows(probe).map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.cls}>{row.text}</dd>
            </div>
          ))}
        </dl>
        <ol>
          <li>
            在 nodejs.org 下载 {shortRequired(probe.required)} 或更高版本（LTS 或 Current
            都可以）并安装。
          </li>
          <li>回到这里点「重新检测」。</li>
        </ol>
        <div className="acts">
          <button
            className="btn primary"
            onClick={() => {
              openUrl("https://nodejs.org/");
            }}
          >
            打开 nodejs.org
          </button>
          <button className="btn" onClick={onProbe} disabled={checking}>
            重新检测
          </button>
        </div>
        <div className="fine">
          已装在别处？设置环境变量 NOCTURNE_NODE 指向 node.exe 后重新检测。
        </div>
      </div>
    </div>
  );
}
