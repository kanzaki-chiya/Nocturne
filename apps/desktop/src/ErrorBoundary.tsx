import { Component, type ReactNode } from "react";

/**
 * 主面板渲染边界：会话/草稿任一组件抛错时不再白屏，
 * 显示真实错误并给「重新加载」入口。
 */
export class PaneErrorBoundary extends Component<
  { children: ReactNode; reload?: () => void },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (error !== null) {
      return (
        <div className="pane-error" role="alert">
          <b>页面渲染出错</b>
          <p>{error.message}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const action =
                this.props.reload ??
                ((): void => {
                  window.location.reload();
                });
              action();
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
