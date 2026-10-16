import type { CommandResult, UnsMessage } from '@shopfloor/contracts';

export interface UnsPublication {
  readonly topic: string;
  readonly message: UnsMessage;
  readonly retain: boolean;
}

/** A command result (`cmd-res`, UNS contract 1.3, #173): never retained. */
export interface CommandResultPublication {
  readonly topic: string;
  readonly message: CommandResult;
  readonly retain: false;
}

/** Anything the gateway publishes through the outbox. */
export type AnyPublication = UnsPublication | CommandResultPublication;

/** Where collectors hand their messages: in practice the store-and-forward outbox (#78). */
export interface Publisher {
  publish(publication: UnsPublication): Promise<void>;
}

/** Where the command executor hands its results: the outbox too. */
export interface ResultPublisher {
  publish(publication: CommandResultPublication): Promise<void>;
}
