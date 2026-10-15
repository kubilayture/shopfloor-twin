import type { UnsMessage } from '@shopfloor/contracts';

export interface UnsPublication {
  readonly topic: string;
  readonly message: UnsMessage;
  readonly retain: boolean;
}

/**
 * Where collectors hand their messages. Until the store-and-forward buffer exists (#78) the gateway
 * publishes straight to the broker; afterwards the buffer implements this interface.
 */
export interface Publisher {
  publish(publication: UnsPublication): Promise<void>;
}
