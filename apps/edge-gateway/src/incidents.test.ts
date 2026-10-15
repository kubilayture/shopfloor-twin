import { parseUnsMessage } from '@shopfloor/contracts';
import { describe, expect, it } from 'vitest';
import { buildGatewayHttp } from './http.ts';
import { TopicSequences } from './identity.ts';
import { UnsIncidentReporter, type IncidentInput } from './incidents.ts';
import type { UnsPublication } from './publisher.ts';

describe('incidents and per-machine metrics (#76)', () => {
  it('publishes each incident as a valid, non-retained message with its own counter, and tells the log', async () => {
    const published: UnsPublication[] = [];
    const logged: IncidentInput[] = [];
    const reporter = new UnsIncidentReporter({
      gatewayId: 'gw-01',
      publisher: {
        publish: (p) => {
          published.push(p);
          return p.message.seq === 2 ? Promise.reject(new Error('broker down')) : Promise.resolve();
        },
      },
      sequences: new TopicSequences(1_800_000_000),
      now: () => Date.UTC(2026, 9, 15, 12),
      onReport: (incident) => logged.push(incident),
    });
    const gap = { type: 'sequence-gap', equipment: 'cnc-01', lost: 3, message: 'lost 3' } as const;
    reporter.report(gap);
    reporter.report({
      type: 'disconnected',
      equipment: 'cnc-01',
      lost: null,
      message: 'lost connection',
    });
    await Promise.resolve();
    expect(published.map((p) => [p.topic, p.retain, p.message.seq])).toEqual([
      ['orbis/gebze/_sys/edge-gateway/gw-01/incidents', false, 1],
      ['orbis/gebze/_sys/edge-gateway/gw-01/incidents', false, 2],
    ]);
    expect(published.every((p) => parseUnsMessage(p.message).ok)).toBe(true);
    expect(published[0]?.message.value).toEqual(gap);
    expect(logged).toHaveLength(2);
    new UnsIncidentReporter({
      gatewayId: 'gw-01',
      publisher: { publish: () => Promise.resolve() },
      sequences: new TopicSequences(1),
    }).report(gap);
  });

  it('exports connection state and fact counts per machine', async () => {
    const http = buildGatewayHttp({
      ready: () => false,
      published: () => 3,
      machines: () => [
        { id: 'cnc-01', connected: true, facts: 12 },
        { id: 'asm-01', connected: false, facts: 0 },
      ],
    });
    const metrics = (await http.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(/^gateway_opcua_connected\{machine="cnc-01"\} 1$/m);
    expect(metrics).toMatch(/^gateway_opcua_connected\{machine="asm-01"\} 0$/m);
    expect(metrics).toMatch(/^gateway_device_facts\{machine="cnc-01"\} 12$/m);
    expect(metrics).toMatch(/^gateway_mqtt_connected 0$/m);
    await http.close();
  });
});
