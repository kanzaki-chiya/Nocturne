export type FocusItem = string;

export function focusOrder(
  fields: readonly { key: string; editable: boolean }[],
  readonly: boolean,
): FocusItem[] {
  return readonly
    ? ["return"]
    : [...fields.filter((field) => field.editable).map((field) => field.key), "cancel", "save"];
}

export function moveFocus(
  order: readonly FocusItem[],
  current: FocusItem,
  direction: "tab" | "shiftTab" | "up" | "down" | "left" | "right",
): FocusItem {
  const index = Math.max(0, order.indexOf(current));
  const firstButton = order.findIndex((item) => item === "cancel" || item === "return");
  const lastField = firstButton - 1;
  if (direction === "tab") return order[(index + 1) % order.length] ?? current;
  if (direction === "shiftTab") return order[(index + order.length - 1) % order.length] ?? current;
  if (direction === "up")
    return order[Math.max(0, index > lastField ? lastField : index - 1)] ?? current;
  if (direction === "down")
    return order[index > lastField ? index : Math.min(lastField, index + 1)] ?? current;
  if (index <= lastField) return current;
  return (
    order[
      Math.max(firstButton, Math.min(order.length - 1, index + (direction === "left" ? -1 : 1)))
    ] ?? current
  );
}
