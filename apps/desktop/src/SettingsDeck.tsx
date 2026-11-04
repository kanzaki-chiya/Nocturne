import { useRef, type ReactNode } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type { SettingsSection } from "./Sidebar";

const SECTIONS: SettingsSection[] = [
  "general",
  "appearance",
  "providers",
  "models",
  "agents",
  "skills",
  "mcp",
  "browser",
  "grants",
  "remote",
  "archive",
  "usage",
  "logs",
];

/** 设置区首次进入时预加载所有页面，离开后保留数据；后台身份变化即释放整代页面。 */
export function SettingsDeck({
  page,
  client,
  version,
  children,
}: {
  page: SettingsSection | null;
  client: RpcClient | undefined;
  version: number;
  children: (section: SettingsSection, refreshVersion: number) => ReactNode;
}) {
  const state = useRef({
    client,
    generation: 0,
    opened: false,
    page: null as SettingsSection | null,
    version,
    versions: Object.fromEntries(SECTIONS.map((section) => [section, 0])) as Record<
      SettingsSection,
      number
    >,
  });
  const current = state.current;
  if (client !== undefined && current.client !== client) {
    current.client = client;
    current.generation++;
    current.opened = false;
  }
  if (current.version !== version) {
    current.version = version;
    for (const section of SECTIONS) current.versions[section]++;
  }
  if (page !== null) current.opened = true;
  if (current.page !== page) {
    current.page = page;
    if (page !== null) current.versions[page]++;
  }
  if (!current.opened) return null;
  return (
    <div key={current.generation} className="settings-deck">
      {SECTIONS.map((section) => (
        <div
          key={section}
          className="settings-slot"
          hidden={page !== section}
          inert={page !== section}
          aria-hidden={page !== section || undefined}
        >
          {children(section, current.versions[section])}
        </div>
      ))}
    </div>
  );
}
