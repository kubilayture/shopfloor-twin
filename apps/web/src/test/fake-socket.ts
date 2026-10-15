import type { ClientMessage, ServerMessage } from '@shopfloor/contracts/mes-api';
import type { LiveSocket } from '../live/live-client.ts';

/** A WebSocket stand-in the test drives: open, push messages, drop the connection. */
export class FakeSocket implements LiveSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: ClientMessage[] = [];
  closedByClient = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(message: ServerMessage | string): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The server or network drops the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

/** Creates sockets for a LiveClient and remembers them, newest last. */
export function socketFactory() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    create: (url: string): FakeSocket => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    get last(): FakeSocket {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket created');
      return socket;
    },
  };
}
