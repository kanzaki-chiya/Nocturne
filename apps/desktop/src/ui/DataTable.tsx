import type { ReactNode } from "react";

export interface DataColumn<Row> {
  key: string;
  header: ReactNode;
  /** 数字列：右对齐、等宽数字 */
  numeric?: boolean | undefined;
  /** 等宽内容（模型 ID、路径、命令） */
  mono?: boolean | undefined;
  /** 次要列（灰字） */
  muted?: boolean | undefined;
  /** 表头无障碍名称（表头文字为空时） */
  label?: string | undefined;
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** 行类名（停用行变淡等） */
  rowClassName?: ((row: Row) => string | undefined) | undefined;
  /** 行悬停说明 */
  rowTitle?: ((row: Row) => string | undefined) | undefined;
  "aria-label"?: string | undefined;
  className?: string | undefined;
}

/** 数据表（`.tbl`）：只有横线；数字列右对齐、等宽数字 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  rowClassName,
  rowTitle,
  "aria-label": ariaLabel,
  className,
}: DataTableProps<Row>) {
  const cellClass = (c: DataColumn<Row>) =>
    [c.numeric === true ? "r" : "", c.mono === true ? "mono" : "", c.muted === true ? "muted" : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className={className === undefined ? "tbl-wrap" : `tbl-wrap ${className}`}>
      <table className="tbl" aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={c.numeric === true ? "r" : undefined}
                aria-label={c.label}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={rowClassName?.(row)} title={rowTitle?.(row)}>
              {columns.map((c) => (
                <td key={c.key} className={cellClass(c)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
