/** 手机网页图标：统一复用公共 MingCute Icon 组件，保持手机网页 20px 默认显示尺寸 */
import { Icon, type IconName } from "../ui";

const PHONE_ICON_SIZE = 20;

function PhoneIcon({ name }: { name: IconName }) {
  return <Icon name={name} size={PHONE_ICON_SIZE} className="phone-icon" />;
}

export const IconBack = () => <PhoneIcon name="arrow_left" />;
export const IconMore = () => <PhoneIcon name="more_1" />;
export const IconSettings = () => <PhoneIcon name="settings_1" />;
export const IconComputer = () => <PhoneIcon name="computer" />;
export const IconChevron = () => <PhoneIcon name="down_small" />;
export const IconHome = () => <PhoneIcon name="home_4" />;
export const IconTime = () => <PhoneIcon name="time" />;
export const IconFolder = () => <PhoneIcon name="folder" />;
export const IconPlus = () => <PhoneIcon name="add" />;
export const IconPaperclip = () => <PhoneIcon name="attachment" />;
export const IconShield = ({ risk: _risk = false }: { risk?: boolean }) => (
  <PhoneIcon name="shield" />
);
export const IconCamera = () => <PhoneIcon name="camera_2" />;
export const IconImage = () => <PhoneIcon name="pic" />;
export const IconAt = () => <PhoneIcon name="at" />;
export const IconTerminal = () => <PhoneIcon name="terminal" />;
export const IconCheck = () => <PhoneIcon name="check" />;
export const IconSend = () => <PhoneIcon name="arrow_up" />;
export const IconStop = () => <PhoneIcon name="stop" />;
export const IconChart = () => <PhoneIcon name="chart_bar" />;

/** 上下文用量圆环：percent 为空时只画底环 */
export function ContextRing({ percent }: { percent: number | null }) {
  const r = 7.5;
  const length = 2 * Math.PI * r;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <svg viewBox="0 0 20 20" width="22" height="22" className="phone-ring" aria-hidden="true">
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--a-border-strong)" strokeWidth="2.2" />
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
