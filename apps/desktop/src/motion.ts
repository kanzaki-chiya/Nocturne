/** A mounted overlay enters once, including when a retained settings page is hidden and restored. */
export function installMotion(doc: Document = document): () => void {
  const activations = new WeakSet<HTMLDetailsElement>();
  const settle = (event: AnimationEvent) => {
    if (!event.animationName.startsWith("nct-enter-")) return;
    if (event.target instanceof HTMLElement) event.target.dataset.motionEntered = "";
  };
  doc.addEventListener("animationend", settle);
  doc.addEventListener("animationcancel", settle);
  // Only a summary activation opts into interpolation. Search/restore expand immediately.
  const activate = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const summary = event.target.closest("summary");
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement) || !details.closest(".conversation")) return;
    if (summary?.getAttribute("aria-disabled") === "true") return;
    activations.add(details);
    details.dataset.motionFold = "";
  };
  // Chromium does not expose ::details-content transitions through document.getAnimations(),
  // nor consistently bubble their end events. Clear stale opt-ins before a programmatic open.
  const observer = new MutationObserver((records) => {
    for (const target of new Set(records.map((record) => record.target))) {
      if (!(target instanceof HTMLDetailsElement)) continue;
      if (activations.has(target)) activations.delete(target);
      else delete target.dataset.motionFold;
    }
  });
  observer.observe(doc, { subtree: true, attributes: true, attributeFilter: ["open"] });
  const finishFold = (event: TransitionEvent) => {
    if (event.target instanceof HTMLDetailsElement && event.propertyName === "height") {
      delete event.target.dataset.motionFold;
    }
  };
  doc.addEventListener("click", activate, true);
  doc.addEventListener("transitionend", finishFold);
  return () => {
    observer.disconnect();
    doc.removeEventListener("animationend", settle);
    doc.removeEventListener("animationcancel", settle);
    doc.removeEventListener("click", activate, true);
    doc.removeEventListener("transitionend", finishFold);
  };
}
