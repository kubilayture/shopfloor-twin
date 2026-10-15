import { sysTopic, type Incident } from '@shopfloor/contracts';
import type { TopicSequences } from './identity.ts';
import type { Publisher } from './publisher.ts';

export type IncidentInput = Pick<Incident['value'], 'type' | 'equipment' | 'lost' | 'message'>;

export interface IncidentReporter {
  report(incident: IncidentInput): void;
}

/** Publishes data-quality incidents on `orbis/gebze/_sys/edge-gateway/{id}/incidents` (not retained). */
export class UnsIncidentReporter implements IncidentReporter {
  readonly topic: string;
  readonly #publisher: Publisher;
  readonly #sequences: TopicSequences;
  readonly #gatewayId: string;
  readonly #now: () => number;
  readonly #onReport: (incident: IncidentInput) => void;

  constructor(options: {
    readonly gatewayId: string;
    readonly publisher: Publisher;
    readonly sequences: TopicSequences;
    readonly now?: () => number;
    readonly onReport?: (incident: IncidentInput) => void;
  }) {
    this.topic = sysTopic('edge-gateway', options.gatewayId, 'incidents');
    this.#publisher = options.publisher;
    this.#sequences = options.sequences;
    this.#gatewayId = options.gatewayId;
    this.#now = options.now ?? Date.now;
    this.#onReport = options.onReport ?? (() => undefined);
  }

  report(incident: IncidentInput): void {
    this.#onReport(incident);
    const now = new Date(this.#now()).toISOString();
    const message: Incident = {
      schema: 'uns.sys.incident/1',
      scope: 'topic',
      epoch: this.#sequences.epoch,
      seq: this.#sequences.next(this.topic),
      sourceTime: now,
      receivedAt: now,
      quality: 'good',
      source: { id: this.#gatewayId, protocol: 'internal' },
      value: incident,
    };
    this.#publisher.publish({ topic: this.topic, message, retain: false }).catch(() => undefined);
  }
}
