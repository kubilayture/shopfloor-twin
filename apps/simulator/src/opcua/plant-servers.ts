import { join } from 'node:path';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { plantAlarms, type PlantConfig } from '@shopfloor/plant-config';
import type { SimTime, Simulation } from '@shopfloor/sim-core';
import type { LineEvent, PlantEvent, ProductionLine, ProductionMode } from '../plant/line.ts';
import type { ProcessValues } from '../plant/process-values.ts';
import { MachineServer } from './machine-server.ts';

export interface PlantServersOptions {
  readonly config: PlantConfig;
  readonly start: SimTime;
  readonly host?: string;
  readonly portOffset?: number;
  readonly pkiFolder?: string;
  /** Start of this run, Unix seconds: the epoch of every device sequence (ADR-0015). */
  readonly epoch?: number;
  /**
   * The line's production mode (#172): in `orders` mode no CNC starts with a `Program` (nothing
   * is loaded until its first job's changeover). `schedule` when left out.
   */
  readonly production?: ProductionMode;
  /** The wall clock `LoadOrder` compares `ExpiresAt` with; `Date.now` when left out. */
  readonly wallClock?: () => number;
}

export interface LiveSources {
  readonly line: ProductionLine;
  readonly simulation: Simulation<LineEvent>;
  readonly processValues: ProcessValues;
}

/** The alarm codes a machine can raise: its slice of the plant's alarm vocabulary (ADR-0024). */
export function alarmCodes(config: PlantConfig, machineId: string): string[] {
  return plantAlarms(config)
    .filter((point) => point.equipment === machineId)
    .map((point) => point.code);
}

export class PlantServers {
  readonly servers: readonly MachineServer[];
  readonly #config: PlantConfig;
  readonly #start: SimTime;
  readonly epoch: number;
  readonly #pending: PlantEvent[] = [];
  readonly #production: ProductionMode;
  #sources: LiveSources | undefined;

  constructor({
    config,
    start,
    host,
    portOffset = 0,
    pkiFolder = join(process.cwd(), '.pki'),
    epoch = Math.floor(Date.now() / 1000),
    production = 'schedule',
    wallClock,
  }: PlantServersOptions) {
    this.epoch = epoch;
    this.#production = production;
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
        alarmCodes: alarmCodes(config, machine.id),
        loadProgram: (product: string, quantity: number) => {
          const sources = this.#sources;
          if (!sources) {
            return {
              ok: false as const,
              code: 'not-attached' as const,
              reason: 'simulation not attached',
            };
          }
          return sources.line.loadProgram(machine.id, product, quantity, sources.simulation);
        },
        loadOrder: (request, wallNow) => {
          const sources = this.#sources;
          // The accepted event must reach this server at once, so that the call can answer its
          // sequence number: not before every server has started and replayed what it missed.
          if (!sources || this.#pending.length > 0 || !this.#started()) {
            return {
              ok: false as const,
              code: 'not-attached' as const,
              reason: 'simulation not attached or servers not started',
            };
          }
          return sources.line.loadOrder(machine.id, request, sources.simulation, {
            epoch: this.epoch,
            wallNow,
          });
        },
        ...(wallClock ? { wallClock } : {}),
        ...(host ? { host } : {}),
      });
    });
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(
      this.servers.map((server) =>
        server.start(
          {
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
          },
          this.#start,
        ),
      ),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      await Promise.allSettled(this.servers.filter((s) => s.started).map((s) => s.stop()));
      throw failed.reason;
    }
    const leak = this.servers.find((s) => s.machineId === 'lkt-01');
    leak?.setInitial('leakUpperLimit', this.#config.process.leakTest.upperLimit, this.#start);
    for (const server of this.servers) {
      server.setInitial('epoch', this.epoch, this.#start);
    }
    // Orders mode (#172): no initial Program; the first changeover sets it.
    if (this.#production === 'schedule') {
      for (const server of this.servers) {
        const first = this.#config.schedule.machines[server.machineId]?.[0];
        if (first) {
          server.setProgram(first.product, this.#start);
        }
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

  /** Takes one machine's server offline or back online; false for an unknown machine. */
  async setOffline(machineId: string, offline: boolean): Promise<boolean> {
    const server = this.servers.find((s) => s.machineId === machineId);
    if (!server) return false;
    await server.setOffline(offline);
    return true;
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
      const server = this.servers.find((s) => s.machineId === event.machineId);
      if (product && server && server.program !== product) {
        server.setProgram(product, event.at);
      }
    }
  }
}
