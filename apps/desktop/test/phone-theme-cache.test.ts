import { afterEach, expect, it, vi } from "vitest";
import {
  applyStoredPhoneAppearance,
  loadThemeHost,
  loadThemePreset,
  saveThemePreset,
  selectThemeHost,
} from "../src/web/local";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

it("手机主题缓存按 hostId 隔离，未知预设与损坏缓存回退工作台", () => {
  saveThemePreset("first", "paper");
  saveThemePreset("second", "ink");
  selectThemeHost("first");
  expect(loadThemeHost()).toBe("first");
  expect(loadThemePreset()).toBe("paper");
  expect(loadThemePreset("second")).toBe("ink");
  expect(loadThemePreset("missing")).toBe("workbench");
  localStorage.setItem("nocturne.phone.themePresets", '{"first":"future"}');
  expect(loadThemePreset()).toBe("workbench");
  for (const raw of ["invalid", "null", "[]"]) {
    localStorage.setItem("nocturne.phone.themePresets", raw);
    expect(loadThemePreset()).toBe("workbench");
  }
});

it("手机入口在数据库和 React 渲染前应用缓存及本机模式", () => {
  saveThemePreset("first", "paper");
  selectThemeHost("first");
  localStorage.setItem("nocturne.phone.theme", "light");
  applyStoredPhoneAppearance(document.documentElement);
  expect(document.documentElement.style.getPropertyValue("--a-bg")).toBe("#fbfaf6");
  expect(document.documentElement.dataset.theme).toBe("light");
  localStorage.setItem("nocturne.phone.theme", "dark");
  applyStoredPhoneAppearance(document.documentElement);
  expect(document.documentElement.style.getPropertyValue("--a-bg")).toBe("#171512");
});

it("手机存储不可读写时主题缓存降级且不影响启动", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => {
    saveThemePreset("first", "paper");
    selectThemeHost("first");
    applyStoredPhoneAppearance(document.documentElement);
  }).not.toThrow();
  expect(loadThemePreset()).toBe("workbench");
});
