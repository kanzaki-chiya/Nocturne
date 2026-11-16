import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThemePref } from "./appearance";
import { PRESETS, previewThemeVars, type CustomTheme, type ThemeVars } from "./theme-presets";
import { Icon, ICON_SM } from "./ui";

const SCROLL_THRESHOLD_PX = 2;
const SCROLL_STEP_RATIO = 0.8;

function scrollCardIntoView(element: HTMLElement | undefined) {
  if (!element) return;
  if (typeof (element as { scrollIntoView?: unknown }).scrollIntoView === "function") {
    element.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
}

function ThemeMini({ vars }: { vars: ThemeVars }) {
  return (
    <span className="theme-mini" style={vars}>
      <span className="theme-mini-side">
        <i />
        <i />
        <i />
      </span>
      <span className="theme-mini-main">
        <i />
        <i />
        <i />
        <span className="theme-mini-input">
          <b />
        </span>
      </span>
    </span>
  );
}

export function ThemeCards({
  value,
  customThemes = [],
  revealSeq = 0,
  onChange,
  onEditCustom,
}: {
  value: string;
  mode?: ThemePref | undefined;
  customThemes?: readonly CustomTheme[] | undefined;
  revealSeq?: number | undefined;
  onChange: (id: string) => void;
  onEditCustom?: ((theme: CustomTheme) => void) | undefined;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const wasVisibleRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const items: readonly { id: string; name: string; custom?: CustomTheme }[] = [
    ...PRESETS.map((preset) => ({ id: preset.id, name: preset.name })),
    ...customThemes.map((theme) => ({ id: theme.id, name: theme.name, custom: theme })),
  ];
  const focusableId = items.some((item) => item.id === value)
    ? value
    : (items[0]?.id ?? "workbench");

  const measureArrows = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const nextLeft = strip.scrollLeft > SCROLL_THRESHOLD_PX;
    const nextRight =
      strip.scrollLeft + strip.clientWidth < strip.scrollWidth - SCROLL_THRESHOLD_PX;
    setCanLeft(nextLeft);
    setCanRight(nextRight);
  }, []);

  const revealCard = useCallback(
    (targetId: string) => {
      const strip = stripRef.current;
      if (!strip) return;
      const cards = strip.querySelectorAll<HTMLElement>("[data-theme-id]");
      for (const card of cards) {
        if (card.dataset.themeId === targetId) {
          scrollCardIntoView(card);
          break;
        }
      }
      measureArrows();
    },
    [measureArrows],
  );

  useLayoutEffect(() => {
    measureArrows();
  }, [items.length, measureArrows]);

  // 初次显示或从隐藏切到可见时把选中卡滚入视野
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const checkVisible = () => {
      const visible = strip.clientWidth > 0;
      if (visible && !wasVisibleRef.current) {
        wasVisibleRef.current = true;
        revealCard(valueRef.current);
      } else {
        if (!visible) wasVisibleRef.current = false;
        measureArrows();
      }
    };
    revealCard(valueRef.current);
    wasVisibleRef.current = strip.clientWidth > 0;

    const onWindowResize = () => {
      checkVisible();
    };
    window.addEventListener("resize", onWindowResize);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => {
        checkVisible();
      });
      observer.observe(strip);
    }
    return () => {
      window.removeEventListener("resize", onWindowResize);
      observer?.disconnect();
    };
  }, [measureArrows, revealCard]);

  // 保存或导入后显式滚到新选中卡
  useEffect(() => {
    if (revealSeq === 0) return;
    revealCard(value);
  }, [revealSeq, value, revealCard]);

  const scrollByStep = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    const delta = direction * strip.clientWidth * SCROLL_STEP_RATIO;
    if (typeof strip.scrollBy === "function") {
      strip.scrollBy({ left: delta, behavior: "smooth" });
    } else {
      strip.scrollLeft += delta;
      measureArrows();
    }
  };

  const wrapClass = ["theme-strip-wrap", canLeft ? "cl" : "", canRight ? "cr" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapClass}>
      {canLeft && (
        <button
          type="button"
          className="theme-strip-arrow left"
          aria-label="向左"
          onClick={() => {
            scrollByStep(-1);
          }}
        >
          <Icon name="left" size={ICON_SM} />
        </button>
      )}
      <div
        ref={stripRef}
        className="theme-strip"
        role="radiogroup"
        aria-label="主题"
        onScroll={measureArrows}
      >
        {items.map((item, index) => {
          const selected = value === item.id;
          const lightVars = previewThemeVars(item.id, "light", customThemes);
          const darkVars = previewThemeVars(item.id, "dark", customThemes);
          return (
            <div key={item.id} className={`theme-card-slot${selected ? " on" : ""}`}>
              <div
                role="radio"
                aria-checked={selected}
                aria-label={item.name}
                tabIndex={focusableId === item.id ? 0 : -1}
                data-theme-id={item.id}
                className={`theme-card${selected ? " on" : ""}`}
                onClick={() => {
                  onChange(item.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onChange(item.id);
                    return;
                  }
                  const delta =
                    event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : event.key === "ArrowLeft" || event.key === "ArrowUp"
                        ? -1
                        : 0;
                  if (delta === 0 && event.key !== "Home" && event.key !== "End") return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : (index + delta + items.length) % items.length;
                  const nextItem = items[next];
                  if (!nextItem) return;
                  onChange(nextItem.id);
                  const radios = stripRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
                  const targetEl = radios?.[next];
                  targetEl?.focus();
                  scrollCardIntoView(targetEl);
                }}
              >
                <span className="theme-dual" aria-hidden="true">
                  <ThemeMini vars={lightVars} />
                  <ThemeMini vars={darkVars} />
                  <span className="theme-dual-cut" />
                </span>
                <span className="theme-name">
                  {item.name}
                  {selected && (
                    <span className="theme-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </span>
              </div>
              {(() => {
                const custom = item.custom;
                if (custom === undefined) return null;
                return (
                  <button
                    type="button"
                    className="theme-pen"
                    aria-label="编辑"
                    onClick={(event) => {
                      event.stopPropagation();
                      onEditCustom?.(custom);
                    }}
                  >
                    <Icon name="edit_2" size={13} />
                  </button>
                );
              })()}
            </div>
          );
        })}
      </div>
      {canRight && (
        <button
          type="button"
          className="theme-strip-arrow right"
          aria-label="向右"
          onClick={() => {
            scrollByStep(1);
          }}
        >
          <Icon name="right" size={ICON_SM} />
        </button>
      )}
    </div>
  );
}
