import { afterEach, expect, it } from "vitest";
import { installMotion } from "../src/motion";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
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

it("only summary activation animates details; programmatic expansion stays immediate", () => {
  dispose = installMotion();
  const conversation = document.createElement("div");
  conversation.className = "conversation";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  details.append(summary);
  conversation.append(details);
  document.body.append(conversation);
  details.open = true;
  expect(details.hasAttribute("data-motion-fold")).toBe(false);
  summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(details.hasAttribute("data-motion-fold")).toBe(true);
  details.dispatchEvent(event("transitionend", { propertyName: "height" }));
  expect(details.hasAttribute("data-motion-fold")).toBe(false);
});
