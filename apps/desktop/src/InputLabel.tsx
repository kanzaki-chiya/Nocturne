import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ICON_SM, Icon } from "./ui/Icon";
import type { InputLabelData } from "./input-labels";
import "./input-label.css";

export function usePluginIconSrc(icon: string | undefined): string | undefined {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(
      icon ?? "",
    );
    const mime = match?.[1];
    const payload = match?.[2];
    if (!mime || !payload) {
      setSrc(undefined);
      return;
    }
    if (typeof URL.createObjectURL !== "function") {
      setSrc(icon);
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      // Desktop CSP permits blob URLs for images.
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setSrc(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    } catch {
      setSrc(undefined);
    }
  }, [icon]);
  return src;
}

export function InputLabelIcon({
  icon,
  image,
  size = ICON_SM,
}: Pick<InputLabelData, "icon" | "image"> & { size?: number }) {
  const src = usePluginIconSrc(image);
  const [failed, setFailed] = useState<string>();
  return src && src !== failed ? (
    <img
      className="input-label-image"
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => {
        setFailed(src);
      }}
    />
  ) : (
    <Icon name={icon} size={size} />
  );
}

export function InputLabel({
  data,
  button,
  anchor,
  dismissible = false,
}: {
  data: InputLabelData;
  button?: { expanded: boolean; onClick: () => void } | undefined;
  anchor?: RefObject<HTMLSpanElement | null>;
  dismissible?: boolean;
}) {
  const content = (
    <>
      {dismissible ? (
        <>
          <span className="work-mode-icon" aria-hidden="true">
            <InputLabelIcon {...data} />
          </span>
          <span className="work-mode-close" aria-hidden="true">
            <Icon name="close_circle" size={ICON_SM} />
          </span>
        </>
      ) : (
        <InputLabelIcon {...data} />
      )}
      <span>{data.label}</span>
    </>
  );
  return button ? (
    <button
      type="button"
      className="input-label input-label-button"
      aria-expanded={button.expanded}
      onClick={button.onClick}
    >
      {content}
    </button>
  ) : (
    <span className="input-label" ref={anchor}>
      {content}
    </span>
  );
}

export function useDraftSkillAnchor(
  field: RefObject<HTMLTextAreaElement | null>,
  label: InputLabelData | undefined,
) {
  const anchor = useRef<HTMLSpanElement>(null);
  const name = label?.label;
  useLayoutEffect(() => {
    const node = field.current;
    const tag = anchor.current;
    if (!node || !tag || name === undefined) return;
    const resize = () => {
      node.style.textIndent = `${tag.getBoundingClientRect().width}px`;
    };
    resize();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : undefined;
    observer?.observe(tag);
    return () => {
      observer?.disconnect();
      node.style.textIndent = "";
    };
  }, [field, name]);
  return anchor;
}

export function useSkillBackspace(
  field: RefObject<HTMLTextAreaElement | null>,
  active: boolean,
  remove: (event: Event) => void,
) {
  const latest = useRef(remove);
  latest.current = remove;
  useEffect(() => {
    const node = field.current;
    if (!active || !node) return;
    const onInput = (event: Event) => {
      if (
        event instanceof InputEvent &&
        event.inputType === "deleteContentBackward" &&
        !event.isComposing &&
        event.cancelable &&
        node.selectionStart === 0 &&
        node.selectionEnd === 0
      ) {
        latest.current(event);
      }
    };
    node.addEventListener("beforeinput", onInput);
    return () => {
      node.removeEventListener("beforeinput", onInput);
    };
  }, [field, active]);
}
