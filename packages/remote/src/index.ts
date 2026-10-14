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
  RelayError,
  registerHost,
  connectHostRelay,
  connectDeviceRelay,
  connectPairRelay,
  type HostRelay,
  type DeviceRelay,
  type RelayConnection,
} from "./relay/client.js";
export {
  RELAY_CLOSE_CODES,
  MAX_CONTROL,
  parseRelayMessage,
  registerTranscript,
  hostAuthTranscript,
  deviceAuthTranscript,
  verifySignature,
  parseInvite,
  type RelayMessage,
  type RelayDevice,
} from "./relay/protocol.js";
export {
  connectChannel,
  acceptChannel,
  type SecureLineTransport,
  type ConnectChannelOptions,
  type AcceptChannelOptions,
} from "./channel.js";
