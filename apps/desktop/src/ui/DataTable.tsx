import { Fragment, type HTMLAttributes, type ReactNode } from "react";

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
  className?: ((row: Row) => string | undefined) | undefined;
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
  /** 可展开行的键盘、点击和无障碍属性 */
  rowProps?: ((row: Row) => HTMLAttributes<HTMLTableRowElement>) | undefined;
  /** 使用行标题单元格的列 */
  rowHeaderKey?: string | undefined;
  /** 紧跟数据行的展开内容，跨全部列 */
  renderDetail?: ((row: Row) => ReactNode) | undefined;
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
  rowProps,
  rowHeaderKey,
  renderDetail,
  "aria-label": ariaLabel,
  className,
}: DataTableProps<Row>) {
  const cellClass = (c: DataColumn<Row>, row: Row) =>
    [
      c.numeric === true ? "r" : "",
      c.mono === true ? "mono" : "",
      c.muted === true ? "muted" : "",
      c.className?.(row),
    ]
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
          {rows.map((row) => {
            const detail = renderDetail?.(row);
            return (
              <Fragment key={rowKey(row)}>
                <tr className={rowClassName?.(row)} title={rowTitle?.(row)} {...rowProps?.(row)}>
                  {columns.map((c) =>
                    c.key === rowHeaderKey ? (
                      <th key={c.key} scope="row" className={cellClass(c, row)}>
                        {c.render(row)}
                      </th>
                    ) : (
                      <td key={c.key} className={cellClass(c, row)}>
                        {c.render(row)}
                      </td>
                    ),
                  )}
                </tr>
                {detail !== undefined && detail !== null && detail !== false && (
                  <tr>
                    <td colSpan={columns.length}>{detail}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
