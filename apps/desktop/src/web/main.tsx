import { createRoot } from "react-dom/client";
import { PhoneApp } from "./App";
import { indexedStorage } from "./storage";
import { takePairingFragment } from "./pairing";
import { registerWorker } from "./push";
import "../styles.css";
import "./phone.css";

// 在打开数据库、联网或渲染前清理一次性秘密，仅在内存中保留。
const fragment = takePairingFragment(location, history);
void registerWorker().catch(() => undefined);
const root = document.getElementById("root");
if (root)
  createRoot(root).render(<PhoneApp storage={indexedStorage()} initialFragment={fragment} />);
