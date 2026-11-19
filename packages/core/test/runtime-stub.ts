import type { Runtime } from "../src/index.js";

const noopUnsubscribe = (): void => undefined;
const noopSubscribe = (): (() => void) => noopUnsubscribe;

const NON_RUNTIME_PROPS = new Set<string>([
  "then",
  "catch",
  "finally",
  "$$typeof",
  "nodeType",
  "asymmetricMatch",
]);

/**
 * 类型化的 Runtime 测试替身工厂（仅供各包测试通过 `@nocturne/core/testing` 引用，
 * 不进入 `@nocturne/core` 的公开运行时导出与构建产物）。
 *
 * - 未覆盖的订阅类成员（`on*`）默认空实现，返回空取消函数；
 * - 其他未覆盖成员一旦被调用即抛错：`runtime stub: <成员名> not stubbed`；
 * - 覆盖项受 `Partial<Runtime>` 约束，签名不匹配会在 typecheck 阶段直接报错。
 */
export function createRuntimeStub(overrides: Partial<Runtime> = {}): Runtime {
  const target: Record<PropertyKey, unknown> = { ...overrides };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (Reflect.has(obj, prop)) {
        return Reflect.get(obj, prop, receiver);
      }
      if (typeof prop === "symbol" || NON_RUNTIME_PROPS.has(prop)) {
        return undefined;
      }
      if (/^on[A-Z]/.test(prop)) {
        return noopSubscribe;
      }
      return () => {
        throw new Error(`runtime stub: ${prop} not stubbed`);
      };
    },
  }) as unknown as Runtime;
}
