import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { build as viteBuild } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionView } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation } from "../../desktop/src/Conversation";
import {
  ImageViewerProvider,
  useImageViewer,
  type ViewerImageItem,
} from "../../desktop/src/ImageViewer";
import type { AttachmentImageSource } from "../../desktop/src/attachment-images";
import { tauriHost } from "../src/host";
import { appPlatform } from "../src/platform";

interface TauriInternalsMock {
  invoke: ReturnType<typeof vi.fn>;
  transformCallback: ReturnType<typeof vi.fn>;
}

function decodeBase64(encoded: string): Uint8Array {
  const bin = atob(encoded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function installTauriMock(
  handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): TauriInternalsMock {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "plugin:background|call") {
      const command = args?.command;
      if (command === "status") return { supported: false, running: false };
      if (command === "notification_status") return { enabled: false };
      if (command === "activity_state") return { foreground: true };
      return {};
    }
    return handler(cmd, args);
  });
  const transformCallback = vi.fn(() => 1);
  (window as unknown as { __TAURI_INTERNALS__: TauriInternalsMock }).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
  };
  return { invoke, transformCallback };
}

function ViewerLauncher({ item }: { item: ViewerImageItem }) {
  const open = useImageViewer();
  return (
    <button
      type="button"
      className="open-viewer"
      onClick={() => {
        open([item], 0);
      }}
    >
      open
    </button>
  );
}

const dummyImages: AttachmentImageSource = {
  url: () => undefined,
  register: async () => "",
  load: async () => "",
  dispose: () => undefined,
};

let root: Root | undefined;
let unhandled: unknown[] = [];
const onUnhandled = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason);
};

beforeEach(() => {
  localStorage.clear();
  unhandled = [];
  window.addEventListener("unhandledrejection", onUnhandled);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
  window.removeEventListener("unhandledrejection", onUnhandled);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 25));
  });
  return container;
}

describe("Android native file & image download", () => {
  it("saves image from ImageViewer via plugin:save-file|save_file and hides copy button", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const mock = installTauriMock(async (cmd) => {
      if (cmd === "plugin:save-file|save_file") return { saved: true };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const platform = appPlatform(tauriHost);
    const blob = new Blob([pngBytes], { type: "image/png" });
    const container = await mount(
      <ImageViewerProvider capabilities={platform.imageViewer} saveFile={platform.saveFile}>
        <ViewerLauncher
          item={{ src: "blob:img-1", filename: "diagram.png", alt: "diagram", blob }}
        />
      </ImageViewerProvider>,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".open-viewer")?.click();
    });

    const dialog = document.body.querySelector<HTMLElement>(".image-viewer");
    if (!dialog) throw new Error("missing viewer dialog");
    const topButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".iv-top .iv-btn"));
    // Only download + close buttons exist on Android (copy remains hidden)
    expect(topButtons).toHaveLength(2);
    const downloadBtn = topButtons[0];
    if (!downloadBtn) throw new Error("missing download button");
    expect(downloadBtn.classList.contains("iv-close")).toBe(false);

    await act(async () => {
      downloadBtn.click();
      await new Promise((done) => setTimeout(done, 30));
    });

    const saveCalls = mock.invoke.mock.calls.filter(
      ([cmd]) => cmd === "plugin:save-file|save_file",
    );
    expect(saveCalls).toHaveLength(1);
    const firstCall = saveCalls[0];
    if (!firstCall) throw new Error("missing save call");
    const payload = firstCall[1] as { name: string; mimeType: string; data: string };
    expect(payload.name).toBe("diagram.png");
    expect(payload.mimeType).toBe("image/png");
    expect(Array.from(decodeBase64(payload.data))).toEqual(Array.from(pngBytes));
    expect(unhandled).toHaveLength(0);
  });

  it("handles user cancellation and failure in ImageViewer without unhandled rejections", async () => {
    let mode: "cancel" | "fail" = "cancel";
    installTauriMock(async (cmd) => {
      if (cmd === "plugin:save-file|save_file") {
        if (mode === "cancel") return { cancelled: true };
        throw new Error("SAF write denied");
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const platform = appPlatform(tauriHost);
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" });
    const container = await mount(
      <ImageViewerProvider capabilities={platform.imageViewer} saveFile={platform.saveFile}>
        <ViewerLauncher item={{ src: "blob:img-2", filename: "shot.png", blob }} />
      </ImageViewerProvider>,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".open-viewer")?.click();
    });
    const downloadBtn = document.body.querySelector<HTMLButtonElement>(
      ".image-viewer .iv-top .iv-btn:not(.iv-close)",
    );
    if (!downloadBtn) throw new Error("missing download button");
    const defaultTitle = downloadBtn.getAttribute("title");

    // 1) Cancel resolves cleanly without changing title
    await act(async () => {
      downloadBtn.click();
      await new Promise((done) => setTimeout(done, 30));
    });
    expect(downloadBtn.getAttribute("title")).toBe(defaultTitle);
    expect(unhandled).toHaveLength(0);

    // 2) Failure sets button title to raw error message without banner or unhandled rejection
    mode = "fail";
    await act(async () => {
      downloadBtn.click();
      await new Promise((done) => setTimeout(done, 30));
    });
    expect(downloadBtn.getAttribute("title")).toBe("SAF write denied");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(unhandled).toHaveLength(0);
  });

  it("saves file attachment card via plugin:save-file|save_file and writes error into title on failure", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    let shouldFail = false;
    const mock = installTauriMock(async (cmd) => {
      if (cmd === "plugin:save-file|save_file") {
        if (shouldFail) throw new Error("Storage quota exceeded");
        return { saved: true };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const readAttachment = vi.fn(async () => ({
      data: pdfBytes,
      mimeType: "application/pdf",
    }));
    const session = {
      id: "sess-1",
      readAttachment,
    } as unknown as RpcSession;

    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u-1",
        seq: 1,
        turnId: "t1",
        content: [{ type: "text", text: "see attached" }],
        files: [
          {
            type: "file",
            file: "att-pdf-1",
            label: "spec.pdf",
            mimeType: "application/pdf",
            bytes: pdfBytes.byteLength,
            sha256: "0".repeat(64),
            source: "upload",
          },
        ],
      },
    ];

    const platform = appPlatform(tauriHost);
    const container = await mount(
      <ImageViewerProvider capabilities={platform.imageViewer} saveFile={platform.saveFile}>
        <Conversation
          session={session}
          view={view}
          openUrl={() => undefined}
          cwd="Z:\\repo"
          subscribeEvents={() => () => undefined}
          images={dummyImages}
          busy={false}
        />
      </ImageViewerProvider>,
    );

    const card = container.querySelector<HTMLButtonElement>("button.fcard");
    if (!card) throw new Error("missing fcard");
    expect(card.getAttribute("title")).toBeNull();

    await act(async () => {
      card.click();
      await new Promise((done) => setTimeout(done, 30));
    });

    expect(readAttachment).toHaveBeenCalledWith("att-pdf-1");
    const saveCalls = mock.invoke.mock.calls.filter(
      ([cmd]) => cmd === "plugin:save-file|save_file",
    );
    expect(saveCalls).toHaveLength(1);
    const firstCall = saveCalls[0];
    if (!firstCall) throw new Error("missing save call");
    const payload = firstCall[1] as { name: string; mimeType: string; data: string };
    expect(payload.name).toBe("spec.pdf");
    expect(payload.mimeType).toBe("application/pdf");
    expect(Array.from(decodeBase64(payload.data))).toEqual(Array.from(pdfBytes));
    expect(card.getAttribute("title")).toBeNull();

    // Failure writes raw error into card title without showing conversation-error alert
    shouldFail = true;
    await act(async () => {
      card.click();
      await new Promise((done) => setTimeout(done, 30));
    });
    expect(card.getAttribute("title")).toBe("Storage quota exceeded");
    expect(container.querySelector(".conversation-error")).toBeNull();
    expect(unhandled).toHaveLength(0);
  });

  it("saves inline HTML page from fullscreen dialog via plugin:save-file|save_file and uses nct-sandbox protocol", async () => {
    const htmlBytes = new TextEncoder().encode(
      "<!doctype html><html><body><h1>报表</h1></body></html>",
    );
    const mock = installTauriMock(async (cmd) => {
      if (cmd === "plugin:save-file|save_file") {
        return { saved: true };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
    );

    const readAttachment = vi.fn(async () => ({
      data: htmlBytes,
      mimeType: "text/html",
      bytes: htmlBytes.byteLength,
    }));
    const session = {
      id: "sess-inline",
      readAttachment,
    } as unknown as RpcSession;

    const view = createSessionView();
    view.entries = [
      {
        kind: "tool",
        key: "t:inline-1",
        turnId: "t1",
        callId: "inline-1",
        name: "render_html",
        seq: 2,
        completedSeq: 3,
        status: "ok",
        input: { title: "报表", html: "<h1>报表</h1>" },
        subjects: [],
        permission: undefined,
        resolution: undefined,
        liveOutput: "",
        result: {
          status: "ok",
          modelContent: "ok",
          output: { title: "报表", file: "file-1.html", bytes: htmlBytes.byteLength },
          error: undefined,
          truncated: false,
          spillPath: undefined,
          files: [
            {
              type: "file",
              file: "file-1.html",
              label: "报表.html",
              mimeType: "text/html",
              bytes: htmlBytes.byteLength,
              sha256: "b".repeat(64),
              source: "upload",
              inline: { title: "报表" },
            },
          ],
          durationMs: 5,
        },
      },
    ];

    const platform = appPlatform(tauriHost);
    const container = await mount(
      <ImageViewerProvider capabilities={platform.imageViewer} saveFile={platform.saveFile}>
        <Conversation
          session={session}
          view={view}
          openUrl={() => undefined}
          cwd="Z:\\repo"
          subscribeEvents={() => () => undefined}
          images={dummyImages}
          busy={false}
        />
      </ImageViewerProvider>,
    );

    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    const iframe = container.querySelector<HTMLIFrameElement>(".inline-page iframe");
    if (!iframe) throw new Error("missing inline iframe");
    expect(iframe.getAttribute("src")).toBe("http://nct-sandbox.localhost/sandbox.html");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");

    const fullBtn = container.querySelector<HTMLButtonElement>('button[aria-label="全屏"]');
    if (!fullBtn) throw new Error("missing fullscreen button");
    await act(async () => {
      fullBtn.click();
    });

    const downloadBtn = document.body.querySelector<HTMLButtonElement>(
      '.inline-page-fullscreen button[aria-label="下载"]',
    );
    if (!downloadBtn) throw new Error("missing fullscreen download button");
    await act(async () => {
      downloadBtn.click();
      await new Promise((done) => setTimeout(done, 30));
    });

    const saveCalls = mock.invoke.mock.calls.filter(
      ([cmd]) => cmd === "plugin:save-file|save_file",
    );
    expect(saveCalls).toHaveLength(1);
    const payload = saveCalls[0]?.[1] as { name: string; mimeType: string; data: string };
    expect(payload.name).toBe("报表.html");
    expect(payload.mimeType).toContain("text/html");
    expect(Array.from(decodeBase64(payload.data))).toEqual(Array.from(htmlBytes));
  });

  it("keeps web bundle free of Android save-file native invoke", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const desktopDir = path.resolve(here, "../../desktop");
    const bundled = await viteBuild({
      root: desktopDir,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        rollupOptions: { input: path.join(desktopDir, "web.html") },
      },
    });
    const outputs = Array.isArray(bundled) ? bundled : [bundled];
    let chunks = 0;
    for (const out of outputs) {
      if (!("output" in out)) continue;
      for (const item of out.output) {
        if (item.type !== "chunk") continue;
        chunks++;
        expect(item.code).not.toContain("plugin:save-file");
        expect(item.code).not.toContain("SaveFilePlugin");
      }
    }
    expect(chunks).toBeGreaterThan(0);
  });
});
