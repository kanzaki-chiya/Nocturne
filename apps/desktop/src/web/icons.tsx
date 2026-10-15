/** 手机网页的线条图标（currentColor），与桌面输入框图标同一画法 */
import type { ReactNode } from "react";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Icon({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      className="phone-icon"
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      role={label === undefined ? undefined : "img"}
    >
      {children}
    </svg>
  );
}

export const IconBack = () => (
  <Icon>
    <path d="M12.5 4 6.5 10l6 6" {...stroke} />
  </Icon>
);
export const IconMore = () => (
  <Icon>
    <circle cx="4.5" cy="10" r="1.3" fill="currentColor" />
    <circle cx="10" cy="10" r="1.3" fill="currentColor" />
    <circle cx="15.5" cy="10" r="1.3" fill="currentColor" />
  </Icon>
);
export const IconSettings = () => (
  <Icon>
    <circle cx="10" cy="10" r="2.6" {...stroke} />
    <path
      d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"
      {...stroke}
    />
  </Icon>
);
export const IconComputer = () => (
  <Icon>
    <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" {...stroke} />
    <path d="M7 16.5h6M10 13.5v3" {...stroke} />
  </Icon>
);
export const IconChevron = () => (
  <Icon>
    <path d="m6 8 4 4 4-4" {...stroke} />
  </Icon>
);
export const IconHome = () => (
  <Icon>
    <path d="M3.5 9 10 3.5 16.5 9v7.5h-4.5v-5h-4v5H3.5z" {...stroke} />
  </Icon>
);
export const IconFolder = () => (
  <Icon>
    <path d="M2.5 5h5l1.8 1.8h8.2v9.7h-15z" {...stroke} />
  </Icon>
);
export const IconPlus = () => (
  <Icon>
    <path d="M10 4v12M4 10h12" {...stroke} />
  </Icon>
);
export const IconPaperclip = () => (
  <Icon>
    <path
      d="m15.5 9.5-5.6 5.6a3.4 3.4 0 0 1-4.8-4.8l6-6a2.3 2.3 0 0 1 3.2 3.2l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.3-5.3"
      {...stroke}
    />
  </Icon>
);
export const IconShield = ({ risk = false }: { risk?: boolean }) => (
  <Icon>
    <path d="M10 2.5 16 4.7v4.6c0 3.9-2.6 6.4-6 7.9-3.4-1.5-6-4-6-7.9V4.7z" {...stroke} />
    {risk ? <path d="M10 6.5v4M10 13.2v.1" {...stroke} /> : null}
  </Icon>
);
export const IconCamera = () => (
  <Icon>
    <path d="M2.5 6.5h3l1.5-2h6l1.5 2h3v9h-15z" {...stroke} />
    <circle cx="10" cy="11" r="3" {...stroke} />
  </Icon>
);
export const IconImage = () => (
  <Icon>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" {...stroke} />
    <circle cx="7" cy="8" r="1.4" fill="currentColor" />
    <path d="m3.5 15 4.5-4.2 3 2.6 2.4-2 3.1 2.9" {...stroke} />
  </Icon>
);
export const IconHistory = () => (
  <Icon>
    <path d="M3.5 10a6.5 6.5 0 1 0 2-4.7M3.5 3.5v3h3" {...stroke} />
    <path d="M10 6.5V10l2.5 1.8" {...stroke} />
  </Icon>
);
export const IconTerminal = () => (
  <Icon>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" {...stroke} />
    <path d="m6 8 2.5 2L6 12M10.5 12.5h3.5" {...stroke} />
  </Icon>
);
export const IconCheck = () => (
  <Icon>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" {...stroke} />
  </Icon>
);
export const IconSend = () => (
  <Icon>
    <path d="M10 16V4.5M5 9.5l5-5 5 5" {...stroke} strokeWidth={1.8} />
  </Icon>
);
export const IconStop = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" />
  </Icon>
);
export const IconChart = () => (
  <Icon>
    <path d="M3.5 16.5h13M6 13.5v-4M10 13.5V5.5M14 13.5v-6" {...stroke} />
  </Icon>
);

/** 上下文用量圆环：percent 为空时只画底环 */
export function ContextRing({ percent }: { percent: number | null }) {
  const r = 7.5;
  const length = 2 * Math.PI * r;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <svg viewBox="0 0 20 20" width="22" height="22" className="phone-ring" aria-hidden="true">
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--a-borderStrong)" strokeWidth="2.2" />
      {value > 0 && (
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          stroke={
            value >= 90 ? "var(--a-error)" : value >= 70 ? "var(--a-warning)" : "var(--a-accent)"
          }
          strokeWidth="2.2"
          strokeDasharray={`${(value / 100) * length} ${length}`}
          strokeLinecap="round"
          transform="rotate(-90 10 10)"
        />
      )}
    </svg>
  );
}
