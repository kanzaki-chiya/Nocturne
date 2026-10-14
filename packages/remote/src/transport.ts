export interface FrameTransport {
  send(frame: Uint8Array): void;
  onFrame(handler: (frame: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export function createMemoryFramePair(): [FrameTransport, FrameTransport] {
  interface End {
    handler: ((frame: Uint8Array) => void) | undefined;
    closeHandler: (() => void) | undefined;
    pending: Uint8Array[];
    closed: boolean;
    notified: boolean;
  }
  const makeEnd = (): End => ({
    handler: undefined,
    closeHandler: undefined,
    pending: [],
    closed: false,
    notified: false,
  });
  const ends = [makeEnd(), makeEnd()] as const;
  const deliver = (end: End): void => {
    while (end.handler !== undefined && end.pending.length > 0) {
      const frame = end.pending.shift();
      if (frame !== undefined) end.handler(frame);
    }
    if (end.closed && end.pending.length === 0 && !end.notified && end.closeHandler !== undefined) {
      end.notified = true;
      end.closeHandler();
    }
  };
  const make = (self: End, peer: End): FrameTransport => ({
    send(frame) {
      if (self.closed || peer.closed) return;
      peer.pending.push(new Uint8Array(frame));
      queueMicrotask(() => {
        deliver(peer);
      });
    },
    onFrame(handler) {
      self.handler = handler;
      queueMicrotask(() => {
        deliver(self);
      });
    },
    onClose(handler) {
      self.closeHandler = handler;
      queueMicrotask(() => {
        deliver(self);
      });
    },
    close() {
      if (self.closed) return;
      self.closed = peer.closed = true;
      queueMicrotask(() => {
        deliver(self);
        deliver(peer);
      });
    },
  });
  return [make(ends[0], ends[1]), make(ends[1], ends[0])];
}
