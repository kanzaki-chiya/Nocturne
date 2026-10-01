/** 兼容入口：权限判定与确认流程统一由 permission 模块实现。 */
export {
  createPolicyGate,
  type GateGrantSink,
  type PolicyGateOptions,
} from "../permission/gate.js";
