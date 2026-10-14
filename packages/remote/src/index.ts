export { RemoteChannelError, type RemoteChannelErrorCode } from "./errors.js";
export { MAX_FRAME, MAX_MESSAGE, FRAME_TYPES } from "./encoding.js";
export {
  generateIdentity,
  exportIdentity,
  importIdentity,
  fingerprint,
  identityId,
  type Identity,
} from "./crypto.js";
export {
  createPairingOffer,
  parsePairingFragment,
  createPairingHello,
  acceptPairingHello,
  finishPairing,
  type ParsedOffer,
  type PairingSecret,
  type PairingState,
} from "./pairing.js";
export { createMemoryFramePair, type FrameTransport } from "./transport.js";
export {
  connectChannel,
  acceptChannel,
  type SecureLineTransport,
  type ConnectChannelOptions,
  type AcceptChannelOptions,
} from "./channel.js";
