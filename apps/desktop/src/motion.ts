/** A mounted overlay enters once, including when a retained settings page is hidden and restored. */
export function installMotion(doc: Document = document): () => void {
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
    details.dataset.motionFold = "";
  };
  const finishFold = (event: TransitionEvent) => {
    if (event.target instanceof HTMLDetailsElement && event.propertyName === "height") {
      delete event.target.dataset.motionFold;
    }
  };
  doc.addEventListener("click", activate, true);
  doc.addEventListener("transitionend", finishFold);
  return () => {
    doc.removeEventListener("animationend", settle);
    doc.removeEventListener("animationcancel", settle);
    doc.removeEventListener("click", activate, true);
    doc.removeEventListener("transitionend", finishFold);
  };
}
