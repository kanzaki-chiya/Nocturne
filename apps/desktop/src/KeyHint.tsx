import { Fragment } from "react";

/** 一组按键提示：range 为真时两个键之间画「–」表示范围（[1]–[4]），否则键挨着排（[↑][↓]） */
export interface KeyHintGroup {
  keys: readonly string[];
  range?: boolean;
  label: string;
}

/** 文案规则 R5：键名 kbd 化，组之间只用间距分开（[1]–[4] 选择  [Esc] 拒绝） */
export function KeyHint({
  groups,
  className,
}: {
  groups: readonly KeyHintGroup[];
  className?: string | undefined;
}) {
  return (
    <span className={`kbd-hint${className === undefined ? "" : ` ${className}`}`}>
      {groups.map((group) => (
        <span key={group.keys.join("-") + group.label}>
          {group.keys.map((key, index) => (
            <Fragment key={key}>
              {index > 0 && group.range === true && "–"}
              <kbd>{key}</kbd>
            </Fragment>
          ))}{" "}
          {group.label}
        </span>
      ))}
    </span>
  );
}
