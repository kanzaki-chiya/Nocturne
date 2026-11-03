// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ICON_DATA, ICON_LG, ICON_MD, ICON_SM, Icon, type IconName } from "../src/ui";

afterEach(cleanup);

describe("Icon", () => {
  it("按指定尺寸渲染 MingCute 线性图标，默认 aria-hidden 并继承 currentColor", () => {
    const { container } = render(<Icon name="search" size={ICON_LG} className="extra" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBe("18");
    expect(svg?.getAttribute("height")).toBe("18");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.classList.contains("icon")).toBe(true);
    expect(svg?.classList.contains("extra")).toBe(true);
    const path = svg?.querySelector("path");
    expect(path?.getAttribute("fill")).toBe("currentColor");
    expect(path?.getAttribute("d")).toBe(ICON_DATA.search.d);
  });

  it("三档标准尺寸常量与每项收录图标的原文件路径可追溯", () => {
    expect([ICON_SM, ICON_MD, ICON_LG]).toEqual([14, 16, 18]);
    for (const [name, def] of Object.entries(ICON_DATA) as [
      IconName,
      (typeof ICON_DATA)[IconName],
    ][]) {
      expect(def.source).toMatch(new RegExp(`^[a-z]+/${name}_line\\.svg$`));
      expect(def.d.length).toBeGreaterThan(10);
    }
  });
});
