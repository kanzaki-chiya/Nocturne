import { useLayoutEffect, useState, type CSSProperties } from "react";
import { resolvedTheme, systemThemeMedia, type ThemePref } from "./appearance";
import { PRESETS, previewThemeVars, type ThemePresetId } from "./theme-presets";

export function ThemeCards({
  value,
  mode,
  onChange,
}: {
  value: ThemePresetId;
  mode: ThemePref;
  onChange: (id: ThemePresetId) => void;
}) {
  const [resolved, setResolved] = useState(() => resolvedTheme(mode));
  useLayoutEffect(() => {
    const media = systemThemeMedia();
    const update = () => {
      setResolved(resolvedTheme(mode));
    };
    update();
    media?.addEventListener?.("change", update);
    return () => {
      media?.removeEventListener?.("change", update);
    };
  }, [mode]);
  return (
    <div className="themes" role="radiogroup" aria-label="主题">
      {PRESETS.map((preset, index) => (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={value === preset.id}
          aria-label={preset.name}
          tabIndex={value === preset.id ? 0 : -1}
          className={`theme-card${value === preset.id ? " on" : ""}`}
          onClick={() => {
            onChange(preset.id);
          }}
          onKeyDown={(event) => {
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
                  ? PRESETS.length - 1
                  : (index + delta + PRESETS.length) % PRESETS.length;
            const id = PRESETS[next]?.id;
            if (id) {
              onChange(id);
              (
                event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined
              )?.focus();
            }
          }}
        >
          <span
            className="theme-mini"
            aria-hidden="true"
            style={previewThemeVars(preset.id, resolved) as CSSProperties}
          >
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
          <span className="theme-name">
            {preset.name}
            {value === preset.id && (
              <span className="theme-check" aria-hidden="true">
                ✓
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
