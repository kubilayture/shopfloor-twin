import { join } from 'node:path';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import type { SimTime, Simulation } from '@shopfloor/sim-core';
import type { LineEvent, PlantEvent, ProductionLine } from '../plant/line.ts';
import type { ProcessValues } from '../plant/process-values.ts';
import { MachineServer } from './machine-server.ts';

export interface PlantServersOptions {
  readonly config: PlantConfig;
  readonly start: SimTime;
  readonly host?: string;
  readonly portOffset?: number;
  readonly pkiFolder?: string;
}

export interface LiveSources {
  readonly line: ProductionLine;
  readonly simulation: Simulation<LineEvent>;
  readonly processValues: ProcessValues;
}

export class PlantServers {
  readonly servers: readonly MachineServer[];
  readonly #config: PlantConfig;
  readonly #start: SimTime;
  readonly #pending: PlantEvent[] = [];
  #sources: LiveSources | undefined;

  constructor({
    config,
    start,
    host,
    portOffset = 0,
    pkiFolder = join(process.cwd(), '.pki'),
  }: PlantServersOptions) {
    this.#config = config;
    this.#start = start;
    const equipment = config.plant.areas.flatMap((a) => a.workCenters.flatMap((w) => w.equipment));
    this.servers = OPCUA_MACHINES.map((machine) => {
      const item = equipment.find((e) => e.id === machine.id);
      if (item?.interface !== 'opcua') {
        throw new Error(`${machine.id} is not an OPC UA machine in the plant configuration`);
      }
      return new MachineServer({
        machineId: machine.id,
        name: item.name,
        kind: machine.kind,
        port: machine.port + portOffset,
        pkiFolder: join(pkiFolder, machine.id),
        ...(host ? { host } : {}),
      });
    });
  }

  async start(): Promise<void> {
    await Promise.all(
      this.servers.map((server) =>
        server.start({
          read: (variable) => {
            const sources = this.#sources;
            if (!sources) {
              return undefined;
            }
            const now = sources.simulation.now;
            const reading = sources.processValues.read(server.machineId, now);
            if (!reading) {
              return undefined;
            }
            return variable === 'spindleLoad'
              ? { value: reading.spindleLoadPercent, at: now }
              : { value: reading.coolantCelsius, at: now };
          },
        }),
      ),
    );
    const leak = this.servers.find((s) => s.machineId === 'lkt-01');
    leak?.setInitial('leakUpperLimit', this.#config.process.leakTest.upperLimit, this.#start);
    for (const server of this.servers) {
      const first = this.#config.schedule.machines[server.machineId]?.[0];
      if (first) {
        server.setProgram(first.product, this.#start);
      }
    }
    for (const event of this.#pending.splice(0)) {
      this.#route(event);
    }
  }

  attach(sources: LiveSources): void {
    this.#sources = sources;
  }

  record(event: PlantEvent): void {
    if (this.#pending.length > 0 || !this.#started()) {
      this.#pending.push(event);
      return;
    }
    this.#route(event);
  }

  async stop(): Promise<void> {
    await Promise.all(this.servers.map((server) => server.stop()));
  }

  #started(): boolean {
    return this.servers.every((server) => server.started);
  }

  #route(event: PlantEvent): void {
    for (const server of this.servers) {
      server.record(event);
    }
    if (event.type === 'state' && event.to === 'Setup' && this.#sources) {
      const station = this.#sources.line.stations.find((s) => s.id === event.machineId);
      const product = station?.loadedProduct;
      if (product) {
        this.servers.find((s) => s.machineId === event.machineId)?.setProgram(product, event.at);
      }
    }
  }
}
