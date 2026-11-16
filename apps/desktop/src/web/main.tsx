import { createRoot } from "react-dom/client";
import { PaneErrorBoundary } from "../ErrorBoundary";
import { PhoneApp } from "./App";
import { indexedStorage } from "./storage";
import { applyStoredPhoneAppearance } from "./local";
import { takePairingFragment } from "./pairing";
import { browserPush, registerWorker } from "./browser-push";
import "../fonts.css";
import "../styles.css";
import "./phone.css";

applyStoredPhoneAppearance(document.documentElement);

// 在打开数据库、联网或渲染前清理一次性秘密，仅在内存中保留。
const fragment = takePairingFragment(location, history);
void registerWorker().catch(() => undefined);
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <PaneErrorBoundary>
      <PhoneApp storage={indexedStorage()} initialFragment={fragment} push={browserPush} />
    </PaneErrorBoundary>,
  );
