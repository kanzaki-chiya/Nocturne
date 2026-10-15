import { generateIdentity, type Identity } from "@nocturne/remote";

export interface PairedHost {
  hostId: string;
  hostPub: string;
  name: string;
  pairedAt: number;
  lastConnectedAt?: number;
  /** 这台电脑所在的中继（小写 URL origin）。App 的页面源不是中继，所以随电脑保存；网页不写，用页面源 */
  origin?: string;
}
export interface PhoneStorage {
  identity(): Promise<Identity>;
  hosts(): Promise<PairedHost[]>;
  putHost(host: PairedHost): Promise<void>;
  removeHost(id: string): Promise<void>;
}
export function memoryStorage(): PhoneStorage {
  let identity: Promise<Identity> | undefined;
  const hosts = new Map<string, PairedHost>();
  return {
    identity: () => (identity ??= generateIdentity({ extractable: false })),
    hosts: () => Promise.resolve([...hosts.values()].map((h) => ({ ...h }))),
    putHost: (host) => {
      hosts.set(host.hostId, { ...host });
      return Promise.resolve();
    },
    removeHost: (id) => {
      hosts.delete(id);
      return Promise.resolve();
    },
  };
}
export function indexedStorage(): PhoneStorage {
  void navigator.storage.persist().catch(() => undefined);
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nocturne-remote", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("identity");
      request.result.createObjectStore("hosts", { keyPath: "hostId" });
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(new Error("无法打开手机存储，请允许网站保存数据"));
    };
  });
  const transaction = async <T>(
    store: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await database;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = run(tx.objectStore(store));
      tx.oncomplete = () => {
        resolve(request.result);
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error("手机存储写入失败"));
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error("手机存储读取失败"));
      };
    });
  };
  let identity: Promise<Identity> | undefined;
  const loadIdentity = async (): Promise<Identity> => {
    const existing = await transaction<Identity | undefined>(
      "identity",
      "readonly",
      (s) => s.get("phone") as IDBRequest<Identity | undefined>,
    );
    if (existing) return existing;
    const generated = await generateIdentity({ extractable: false });
    // 生成在事务外；写事务内再次读，避免两个标签页分别覆盖身份。
    const db = await database;
    return new Promise<Identity>((resolve, reject) => {
      const tx = db.transaction("identity", "readwrite");
      const store = tx.objectStore("identity");
      const request = store.get("phone") as IDBRequest<Identity | undefined>;
      let result = generated;
      request.onsuccess = () => {
        if (request.result) result = request.result;
        else store.put(generated, "phone");
      };
      tx.oncomplete = () => {
        resolve(result);
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error("无法保存手机身份"));
      };
    });
  };
  return {
    identity: () => (identity ??= loadIdentity()),
    hosts: () =>
      transaction<PairedHost[]>("hosts", "readonly", (s) => s.getAll() as IDBRequest<PairedHost[]>),
    putHost: async (host) => {
      await transaction("hosts", "readwrite", (s) => s.put(host));
    },
    removeHost: async (id) => {
      await transaction("hosts", "readwrite", (s) => s.delete(id));
    },
  };
}

export function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function decode(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
