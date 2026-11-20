/**
 * pdf.js 6.5.438 自定义 BinaryDataFactory（对应 node_modules/pdfjs-dist/build/pdf.mjs:7893-7932）：
 * 在 connect-src 'none' 沙箱下禁止一切网络 fetch，由主线程经 MCP viewer_asset 工具按名读取
 * cMap（kind="cMapUrl"）、标准字体（kind="standardFontDataUrl"）与 WebAssembly（kind="wasmUrl"）。
 */
export type PdfjsAssetKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

export interface BinaryDataFetchRequest {
  readonly kind: string;
  readonly filename: string;
}

export interface BinaryDataFactoryConstructorOptions {
  readonly cMapUrl?: string | null;
  readonly standardFontDataUrl?: string | null;
  readonly wasmUrl?: string | null;
}

export type FetchViewerAssetFn = (assetName: string) => Promise<Uint8Array>;

export interface ViewerBinaryDataFactoryOptions {
  readonly fetchAsset: FetchViewerAssetFn;
  readonly onRequest?: ((kind: string, filename: string, assetName: string) => void) | undefined;
}

const KIND_TO_PREFIX: Readonly<Record<string, string>> = {
  cMapUrl: "cmaps/",
  standardFontDataUrl: "standard_fonts/",
  wasmUrl: "wasm/",
};

export function mapBinaryDataRequestToAssetName(kind: string, filename: string): string {
  const prefix = KIND_TO_PREFIX[kind];
  if (!prefix) {
    throw new Error(`Unsupported pdf.js binary data kind: ${kind}`);
  }
  const cleanName = filename.replace(/^\/+/, "");
  return `${prefix}${cleanName}`;
}

export interface PdfjsBinaryDataFactoryLike {
  readonly cMapUrl: string | null;
  readonly standardFontDataUrl: string | null;
  readonly wasmUrl: string | null;
  fetch(req: BinaryDataFetchRequest): Promise<Uint8Array>;
}

export type PdfjsBinaryDataFactoryCtor = new (
  options?: BinaryDataFactoryConstructorOptions,
) => PdfjsBinaryDataFactoryLike;

export function createViewerBinaryDataFactory(
  options: ViewerBinaryDataFactoryOptions,
): PdfjsBinaryDataFactoryCtor {
  const cache = new Map<string, Promise<Uint8Array>>();

  return class ViewerBinaryDataFactory implements PdfjsBinaryDataFactoryLike {
    readonly cMapUrl: string | null;
    readonly standardFontDataUrl: string | null;
    readonly wasmUrl: string | null;

    constructor(init: BinaryDataFactoryConstructorOptions = {}) {
      this.cMapUrl = init.cMapUrl ?? "cmaps/";
      this.standardFontDataUrl = init.standardFontDataUrl ?? "standard_fonts/";
      this.wasmUrl = init.wasmUrl ?? "wasm/";
    }

    async fetch({ kind, filename }: BinaryDataFetchRequest): Promise<Uint8Array> {
      const assetName = mapBinaryDataRequestToAssetName(kind, filename);
      options.onRequest?.(kind, filename, assetName);

      let pending = cache.get(assetName);
      if (!pending) {
        pending = options.fetchAsset(assetName).catch((err: unknown) => {
          cache.delete(assetName);
          throw err;
        });
        cache.set(assetName, pending);
      }
      const bytes = await pending;
      // 返回独立副本，避免 pdf.js 传给 Worker 时 transfer 掉缓存中的底层 ArrayBuffer
      return bytes.slice();
    }
  };
}
