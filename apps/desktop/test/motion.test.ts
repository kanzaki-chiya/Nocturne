import { afterEach, expect, it, vi } from "vitest";
import { installMotion, motionAllowed, runThemeTransition } from "../src/motion";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  delete document.documentElement.dataset.reduceMotion;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function event(type: string, values: Record<string, string>): Event {
  return Object.assign(new Event(type, { bubbles: true }), values);
}

it("settles retained overlays after completion or hiding without suppressing a new instance", () => {
  dispose = installMotion();
  const overlay = document.createElement("div");
  document.body.append(overlay);
  overlay.dispatchEvent(event("animationend", { animationName: "unrelated" }));
  expect(overlay.hasAttribute("data-motion-entered")).toBe(false);
  overlay.dispatchEvent(event("animationcancel", { animationName: "nct-enter-menu" }));
  expect(overlay.hasAttribute("data-motion-entered")).toBe(true);
  overlay.hidden = true;
  overlay.hidden = false;
  expect(overlay.hasAttribute("data-motion-entered")).toBe(true);
  const replacement = document.createElement("div");
  overlay.replaceWith(replacement);
  expect(replacement.hasAttribute("data-motion-entered")).toBe(false);
});

it("only summary activation animates details; programmatic expansion stays immediate", async () => {
  dispose = installMotion();
  const conversation = document.createElement("div");
  conversation.className = "conversation";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  details.append(summary);
  conversation.append(details);
  document.body.append(conversation);
  details.open = true;
  await Promise.resolve();
  expect(details.hasAttribute("data-motion-fold")).toBe(false);
  summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(details.hasAttribute("data-motion-fold")).toBe(true);
  details.dispatchEvent(event("transitionend", { propertyName: "height" }));
  expect(details.hasAttribute("data-motion-fold")).toBe(false);
});

it("clears a stale fold opt-in before a later programmatic jump, even without transitionend", async () => {
  dispose = installMotion();
  const conversation = document.createElement("div");
  conversation.className = "conversation";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  details.append(summary);
  conversation.append(details);
  document.body.append(conversation);
  summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  details.open = true;
  await Promise.resolve();
  expect(details.hasAttribute("data-motion-fold")).toBe(true);
  details.open = false;
  await Promise.resolve();
  expect(details.hasAttribute("data-motion-fold")).toBe(false);
});

it("motionAllowed: data-reduce-motion takes priority over media query", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: no-preference)",
  }));
  expect(motionAllowed()).toBe(true);
  document.documentElement.dataset.reduceMotion = "";
  expect(motionAllowed()).toBe(false);
  delete document.documentElement.dataset.reduceMotion;
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  expect(motionAllowed()).toBe(false);
});

it("runThemeTransition applies directly without startViewTransition and uses startViewTransition when allowed", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: no-preference)",
  }));
  let count = 0;
  runThemeTransition(() => {
    count += 1;
  });
  expect(count).toBe(1);

  const startViewTransition = vi.fn((update: () => void) => {
    update();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  try {
    runThemeTransition(() => {
      count += 1;
    });
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(count).toBe(2);

    document.documentElement.dataset.reduceMotion = "";
    runThemeTransition(() => {
      count += 1;
    });
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(count).toBe(3);
  } finally {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  }
});
