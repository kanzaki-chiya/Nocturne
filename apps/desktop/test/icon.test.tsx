// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ICON_DATA, ICON_LG, ICON_MD, ICON_SM, Icon, MoonMark, type IconName } from "../src/ui";

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

describe("MoonMark", () => {
  it("渲染 13 条扫描线新月并使用主题 CSS 变量与唯一 id", () => {
    const { container } = render(
      <>
        <MoonMark size={40} />
        <MoonMark size={36} />
      </>,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    expect(svgs[0]?.getAttribute("width")).toBe("40");
    expect(svgs[1]?.getAttribute("width")).toBe("36");
    for (const svg of svgs) {
      expect(svg.getAttribute("viewBox")).toBe("143 143 738 738");
      expect(svg.querySelectorAll("rect")).toHaveLength(13);
      const stops = svg.querySelectorAll("linearGradient stop");
      expect(stops).toHaveLength(2);
      expect(stops[0]?.getAttribute("stop-color")).toBe("var(--a-accent)");
      expect(stops[1]?.getAttribute("stop-color")).toBe("var(--a-accentAlt)");
    }
    const g0 = svgs[0]?.querySelector("linearGradient")?.getAttribute("id");
    const g1 = svgs[1]?.querySelector("linearGradient")?.getAttribute("id");
    expect(g0).toBeTruthy();
    expect(g1).toBeTruthy();
    expect(g0).not.toBe(g1);
  });
});
