import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaneErrorBoundary } from "../src/ErrorBoundary";

afterEach(cleanup);

function Boom(): never {
  throw new Error("boom_render");
}

describe("PaneErrorBoundary", () => {
  it("子树渲染抛错时显示错误信息并提供重新加载按钮", () => {
    const reload = vi.fn();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <PaneErrorBoundary reload={reload}>
          <Boom />
        </PaneErrorBoundary>,
      );
    } finally {
      quiet.mockRestore();
    }
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("页面渲染出错");
    expect(alert.textContent).toContain("boom_render");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("无错误时正常渲染子树", () => {
    render(
      <PaneErrorBoundary>
        <div>正常内容</div>
      </PaneErrorBoundary>,
    );
    expect(screen.getByText("正常内容")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
