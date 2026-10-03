/**
 * 传输抽象：按行收发。stdio、WebSocket、Tauri 事件通道都只需要实现它
 * （ADR-0044 第 1、2 节：服务端与传输无关）。
 */
export interface LineTransport {
  /** 发送一条报文（不含换行；传输层负责加分隔符） */
  send(line: string): void;
  /** 注册收到一行的处理函数；注册前已到达的行要缓冲到注册时再交付 */
  onLine(handler: (line: string) => void): void;
  /** 注册连接结束的处理函数（对端关闭、进程退出、本端 close 都触发，且只触发一次） */
  onClose(handler: () => void): void;
  /** 主动关闭 */
  close(): void;
}

/**
 * 同进程内存管道：两端互为对端，按发送顺序异步交付。一端 close 后，
 * 对端先收完已发送的行，再收到 close。测试与嵌入方使用。
 */
export function createMemoryTransportPair(): [LineTransport, LineTransport] {
  interface End {
    handler: ((line: string) => void) | undefined;
    closeHandler: (() => void) | undefined;
    pending: string[];
    closed: boolean;
    closeNotified: boolean;
  }
  const makeEnd = (): End => ({
    handler: undefined,
    closeHandler: undefined,
    pending: [],
    closed: false,
    closeNotified: false,
  });
  const ends = [makeEnd(), makeEnd()] as const;

  const deliver = (end: End): void => {
    while (end.handler !== undefined && end.pending.length > 0) {
      const line = end.pending.shift();
      if (line !== undefined) end.handler(line);
    }
    if (
      end.closed &&
      end.pending.length === 0 &&
      !end.closeNotified &&
      end.closeHandler !== undefined
    ) {
      end.closeNotified = true;
      end.closeHandler();
    }
  };

  const make = (self: End, peer: End): LineTransport => ({
    send(line) {
      if (self.closed || peer.closed) return;
      peer.pending.push(line);
      queueMicrotask(() => {
        deliver(peer);
      });
    },
    onLine(handler) {
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
      self.closed = true;
      peer.closed = true;
      queueMicrotask(() => {
        deliver(self);
        deliver(peer);
      });
    },
  });
  return [make(ends[0], ends[1]), make(ends[1], ends[0])];
}
