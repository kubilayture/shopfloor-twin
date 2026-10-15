import {
  OPCUA_EVENT_FIELD_TYPES,
  OPCUA_EVENT_FIELDS,
  OPCUA_EVENT_TYPES,
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
  opcuaAlarmPath,
  type OpcuaVariable,
} from '@shopfloor/contracts';
import {
  DataType,
  DataValue,
  EventNotifierFlags,
  OPCUACertificateManager,
  OPCUAServer,
  StatusCodes,
  nodesets,
  promoteToStateMachine,
  type AddressSpace,
  type Namespace,
  type UAObject,
  type UAObjectType,
  type UAEventType,
  type UAVariable,
  type VariantOptions,
} from 'node-opcua';
import type { SimTime } from '@shopfloor/sim-core';
import type { LoadProgramResult, PlantEvent } from '../plant/line.ts';
import type { MachineState } from '../plant/machine-state.ts';
import { machineryItemState, machineryOperationMode } from './machinery-state.ts';

const MACHINERY = 'http://opcfoundation.org/UA/Machinery/';
const MACHINE_TOOL = 'http://opcfoundation.org/UA/MachineTool/';
const DI = 'http://opcfoundation.org/UA/DI/';

export const COMPANION_NODESETS = [
  nodesets.standard,
  nodesets.di,
  nodesets.ia,
  nodesets.isa95JobControl,
  nodesets.machinery,
  nodesets.machineryJobs,
  nodesets.machineryResult,
  nodesets.machineTool,
];

export interface MachineServerOptions {
  readonly machineId: string;
  readonly name: string;
  readonly kind: 'machine-tool' | 'station';
  readonly port: number;
  readonly host?: string;
  readonly pkiFolder: string;
  readonly alarmCodes?: readonly string[];
  readonly loadProgram?: (product: string, quantity: number) => LoadProgramResult;
}

export interface TelemetrySource {
  read(variable: OpcuaVariable): { value: number; at: SimTime } | undefined;
}

type ValueKind = 'String' | 'UInt32' | 'Double';

const VARIABLE_TYPES: Record<OpcuaVariable, ValueKind> = {
  state: 'String',
  stateCause: 'String',
  sequence: 'UInt32',
  produced: 'UInt32',
  good: 'UInt32',
  scrap: 'UInt32',
  rework: 'UInt32',
  lastSerial: 'String',
  program: 'String',
  operator: 'String',
  spindleLoad: 'Double',
  coolantTemperature: 'Double',
  leakRate: 'Double',
  leakUpperLimit: 'Double',
  alarmsActiveCount: 'UInt32',
};

const TELEMETRY: readonly OpcuaVariable[] = ['spindleLoad', 'coolantTemperature'];

export class MachineServer {
  readonly machineId: string;
  readonly port: number;
  readonly #options: MachineServerOptions;
  readonly #server: OPCUAServer;
  readonly #variables = new Map<OpcuaVariable, UAVariable>();
  readonly #counters = { produced: 0, good: 0, scrap: 0, rework: 0 };
  readonly #alarms = new Map<string, UAVariable>();
  readonly #activeAlarms = new Set<string>();
  #machine: UAObject | undefined;
  #eventTypes: Partial<Record<keyof typeof OPCUA_EVENT_TYPES, UAEventType>> = {};
  #itemState: ReturnType<typeof promoteToStateMachine> | undefined;
  #operationMode: ReturnType<typeof promoteToStateMachine> | undefined;
  #sequence = 0;

  constructor(options: MachineServerOptions) {
    this.#options = options;
    this.machineId = options.machineId;
    this.port = options.port;
    this.#server = new OPCUAServer({
      port: options.port,
      ...(options.host ? { hostname: options.host } : {}),
      nodeset_filename: COMPANION_NODESETS,
      serverCertificateManager: new OPCUACertificateManager({
        rootFolder: options.pkiFolder,
        automaticallyAcceptUnknownCertificate: true,
      }),
      serverCapabilities: { minSupportedSampleRate: 0 },
      buildInfo: {
        productName: `ShopFloor Twin ${options.name}`,
        manufacturerName: 'Orbis Components (simulated)',
      },
      serverInfo: {
        applicationUri: `${SHOPFLOOR_NAMESPACE_URI}:${options.machineId}`,
        productUri: SHOPFLOOR_NAMESPACE_URI,
        applicationName: { text: `ShopFloor Twin ${options.machineId}` },
      },
    });
  }

  #started = false;

  get started(): boolean {
    return this.#started;
  }

  get sequence(): number {
    return this.#sequence;
  }

  get endpoint(): string {
    return this.#server.getEndpointUrl();
  }

  async start(telemetry: TelemetrySource, startTime: SimTime): Promise<void> {
    await this.#server.initialize();
    const addressSpace = this.#server.engine.addressSpace;
    if (!addressSpace) {
      throw new Error(`${this.machineId}: address space not available`);
    }
    this.#build(addressSpace, telemetry);
    this.#initialise(startTime);
    await this.#server.start();
    this.#started = true;
  }

  async stop(): Promise<void> {
    await this.#server.shutdown(0);
  }

  setInitial(variable: OpcuaVariable, value: string | number, at: SimTime): void {
    this.#set(variable, value, at);
  }

  record(event: PlantEvent): void {
    if (!('machineId' in event) || event.machineId !== this.machineId) {
      return;
    }
    switch (event.type) {
      case 'state':
        this.#onState(event.from, event.to, event.cause, event.at);
        break;
      case 'cycle-complete':
        this.#onCycle(event);
        break;
      case 'operator':
        this.#set('operator', event.operatorId ?? '', event.at);
        break;
      case 'alarm':
        this.#onAlarm(event);
        break;
      case 'material-consumed':
      case 'program-loaded':
      case 'repair-start':
      case 'repair-end':
        break;
    }
  }

  #program = '';

  get program(): string {
    return this.#program;
  }

  setProgram(product: string, at: SimTime): void {
    this.#program = product;
    this.#set('program', product, at);
  }

  #onState(from: MachineState, to: MachineState, cause: string | undefined, at: SimTime): void {
    const sequence = this.#next(at);
    this.#set('state', to, at);
    this.#set('stateCause', cause ?? '', at);
    this.#itemState?.setState(machineryItemState(to));
    this.#operationMode?.setState(machineryOperationMode(to));
    this.#raise('stateChange', at, `${this.machineId}: ${from} → ${to}`, sequence, {
      fromState: { dataType: DataType.String, value: from },
      toState: { dataType: DataType.String, value: to },
      cause: { dataType: DataType.String, value: cause ?? '' },
    });
  }

  #onCycle(event: Extract<PlantEvent, { type: 'cycle-complete' }>): void {
    const sequence = this.#next(event.at);
    this.#counters.produced++;
    this.#counters[event.result]++;
    this.#set('produced', this.#counters.produced, event.at);
    this.#set(event.result, this.#counters[event.result], event.at);
    this.#set('lastSerial', event.serial, event.at);
    if (event.measurement) {
      this.#set('leakRate', event.measurement.value, event.at);
    }
    this.#raise(
      'cycleComplete',
      event.at,
      `${this.machineId}: ${event.serial} ${event.result}`,
      sequence,
      {
        product: { dataType: DataType.String, value: event.product },
        partId: { dataType: DataType.UInt32, value: event.partId },
        serial: { dataType: DataType.String, value: event.serial },
        result: { dataType: DataType.String, value: event.result },
        reason: { dataType: DataType.String, value: event.reason ?? '' },
        measurementValue: {
          dataType: DataType.Double,
          value: event.measurement?.value ?? Number.NaN,
        },
      },
    );
  }

  #onAlarm(event: Extract<PlantEvent, { type: 'alarm' }>): void {
    const sequence = this.#next(event.at);
    const active = event.transition === 'active';
    if (active) {
      this.#activeAlarms.add(event.code);
    } else {
      this.#activeAlarms.delete(event.code);
    }
    this.#alarms
      .get(event.code)
      ?.setValueFromSource(
        { dataType: DataType.Boolean, value: active },
        StatusCodes.Good,
        new Date(event.at),
      );
    this.#set('alarmsActiveCount', this.#activeAlarms.size, event.at);
    this.#raise(
      'alarm',
      event.at,
      `${this.machineId}: ${event.code} ${event.transition}`,
      sequence,
      {
        alarmCode: { dataType: DataType.String, value: event.code },
        transition: { dataType: DataType.String, value: event.transition },
      },
      event.severity,
    );
  }

  #initialise(at: SimTime): void {
    for (const alarm of this.#alarms.values()) {
      alarm.setValueFromSource(
        { dataType: DataType.Boolean, value: false },
        StatusCodes.Good,
        new Date(at),
      );
    }
    for (const [variable, kind] of Object.entries(VARIABLE_TYPES) as [OpcuaVariable, ValueKind][]) {
      if (!TELEMETRY.includes(variable)) {
        this.#set(variable, variable === 'state' ? 'Off' : kind === 'String' ? '' : 0, at);
      }
    }
  }

  #next(at: SimTime): number {
    this.#sequence++;
    this.#set('sequence', this.#sequence, at);
    return this.#sequence;
  }

  #raise(
    kind: keyof typeof OPCUA_EVENT_TYPES,
    at: SimTime,
    message: string,
    sequence: number,
    fields: Record<string, VariantOptions>,
    severity = 200,
  ): void {
    const eventType = this.#eventTypes[kind];
    if (!eventType || !this.#machine) {
      return;
    }
    this.#machine.raiseEvent(eventType, {
      time: { dataType: DataType.DateTime, value: new Date(at) },
      message: { dataType: DataType.LocalizedText, value: { text: message } },
      severity: { dataType: DataType.UInt16, value: severity },
      sequence: { dataType: DataType.UInt32, value: sequence },
      machineId: { dataType: DataType.String, value: this.machineId },
      ...fields,
    });
  }

  #set(variable: OpcuaVariable, value: string | number, at: SimTime): void {
    const node = this.#variables.get(variable);
    if (!node) {
      return;
    }
    const kind = VARIABLE_TYPES[variable];
    node.setValueFromSource({ dataType: DataType[kind], value }, StatusCodes.Good, new Date(at));
  }

  #build(addressSpace: AddressSpace, telemetry: TelemetrySource): void {
    const ns = addressSpace.registerNamespace(SHOPFLOOR_NAMESPACE_URI);
    const machineryNs = addressSpace.getNamespaceIndex(MACHINERY);
    const machinesFolder = addressSpace.findNode(
      `ns=${String(machineryNs)};i=1001`,
    ) as UAObject | null;
    const organizedBy = machinesFolder ?? addressSpace.rootFolder.objects;
    const machine = this.#createMachine(addressSpace, ns, organizedBy);
    this.#machine = machine;
    const server = addressSpace.rootFolder.objects.server;
    server.addReference({ referenceType: 'HasNotifier', nodeId: machine });
    server.addReference({ referenceType: 'HasEventSource', nodeId: machine });

    const shopFloor = ns.addObject({
      browseName: 'ShopFloor',
      nodeId: `s=${this.machineId}.ShopFloor`,
      componentOf: machine,
    });
    const folders = new Map<string, UAObject>([['ShopFloor', shopFloor]]);
    const folder = (path: string[]): UAObject => {
      let parent = shopFloor;
      for (let i = 1; i < path.length; i++) {
        const key = path.slice(0, i + 1).join('.');
        let child = folders.get(key);
        if (!child) {
          child = ns.addObject({
            browseName: path[i] ?? '',
            nodeId: `s=${this.machineId}.${key}`,
            componentOf: parent,
          });
          folders.set(key, child);
        }
        parent = child;
      }
      return parent;
    };
    for (const [key, path] of Object.entries(OPCUA_VARIABLES) as [OpcuaVariable, string][]) {
      if (!this.#exposes(key)) {
        continue;
      }
      const segments = path.split('.');
      const parent = folder(segments.slice(0, -1));
      const kind = VARIABLE_TYPES[key];
      const isTelemetry = TELEMETRY.includes(key);
      const variable = ns.addVariable({
        componentOf: parent,
        browseName: segments.at(-1) ?? key,
        nodeId: `s=${this.machineId}.${path}`,
        dataType: kind,
        minimumSamplingInterval: isTelemetry ? 100 : 0,
        ...(isTelemetry
          ? {
              value: {
                timestamped_get: () => {
                  const reading = telemetry.read(key);
                  return reading
                    ? new DataValue({
                        value: { dataType: DataType.Double, value: reading.value },
                        sourceTimestamp: new Date(reading.at),
                        statusCode: StatusCodes.Good,
                      })
                    : new DataValue({
                        statusCode: StatusCodes.UncertainNoCommunicationLastUsableValue,
                      });
                },
              },
            }
          : {}),
      });
      this.#variables.set(key, variable);
    }

    for (const code of this.#options.alarmCodes ?? []) {
      const segments = opcuaAlarmPath(code).split('.');
      this.#alarms.set(
        code,
        ns.addVariable({
          componentOf: folder(segments.slice(0, -1)),
          browseName: 'Active',
          nodeId: `s=${this.machineId}.${opcuaAlarmPath(code)}`,
          dataType: 'Boolean',
          minimumSamplingInterval: 0,
        }),
      );
    }

    const loadProgram = this.#options.loadProgram;
    if (loadProgram && this.#options.kind === 'machine-tool') {
      const method = ns.addMethod(shopFloor, {
        browseName: 'LoadProgram',
        nodeId: `s=${this.machineId}.${OPCUA_METHODS.loadProgram}`,
        inputArguments: [
          {
            name: 'Product',
            dataType: DataType.String,
            description: { text: 'Product id, e.g. VB-200' },
          },
          { name: 'Quantity', dataType: DataType.UInt32, description: { text: 'Parts to make' } },
        ],
        outputArguments: [
          {
            name: 'Position',
            dataType: DataType.UInt32,
            description: { text: 'Position in the CNC queue (1 = next)' },
          },
        ],
      });
      method.bindMethod((inputArguments, _context, callback) => {
        const [product, quantity] = inputArguments.map((argument) => argument.value as unknown);
        const result: LoadProgramResult =
          typeof product === 'string' && typeof quantity === 'number'
            ? loadProgram(product, quantity)
            : { ok: false, code: 'invalid-product', reason: 'expected (String, UInt32)' };
        if (result.ok) {
          callback(null, {
            statusCode: StatusCodes.Good,
            outputArguments: [{ dataType: DataType.UInt32, value: result.position }],
          });
          return;
        }
        const good = StatusCodes.Good;
        const bad = StatusCodes.BadInvalidArgument;
        callback(null, {
          statusCode: result.code === 'not-attached' ? StatusCodes.BadInvalidState : bad,
          inputArgumentResults:
            result.code === 'invalid-product'
              ? [bad, good]
              : result.code === 'invalid-quantity'
                ? [good, bad]
                : [good, good],
        });
      });
    }

    for (const [kind, browseName] of Object.entries(OPCUA_EVENT_TYPES) as [
      keyof typeof OPCUA_EVENT_TYPES,
      string,
    ][]) {
      const existing = addressSpace.findEventType(browseName, ns.index);
      const baseEventType = addressSpace.findEventType('BaseEventType');
      if (!baseEventType) {
        throw new Error('BaseEventType not found');
      }
      const eventType =
        existing ??
        ns.addObjectType({
          browseName,
          nodeId: `s=${browseName}`,
          subtypeOf: baseEventType,
          isAbstract: false,
        });
      if (!existing) {
        for (const field of [...OPCUA_EVENT_FIELDS.common, ...OPCUA_EVENT_FIELDS[kind]]) {
          const dataType = OPCUA_EVENT_FIELD_TYPES[field];
          ns.addVariable({
            propertyOf: eventType,
            browseName: field,
            dataType,
            modellingRule: 'Mandatory',
          });
        }
      }
      this.#eventTypes[kind] = eventType;
    }
  }

  #exposes(variable: OpcuaVariable): boolean {
    switch (variable) {
      case 'program':
      case 'spindleLoad':
      case 'coolantTemperature':
        return this.#options.kind === 'machine-tool';
      case 'operator':
        return this.machineId === 'asm-01';
      case 'leakRate':
      case 'leakUpperLimit':
        return this.machineId === 'lkt-01';
      case 'state':
      case 'stateCause':
      case 'sequence':
      case 'produced':
      case 'good':
      case 'scrap':
      case 'rework':
      case 'lastSerial':
      case 'alarmsActiveCount':
        return true;
    }
  }

  #createMachine(addressSpace: AddressSpace, ns: Namespace, organizedBy: UAObject): UAObject {
    const machineryNs = addressSpace.getNamespaceIndex(MACHINERY);
    const diNs = addressSpace.getNamespaceIndex(DI);
    const find = (name: string, namespaceUri: string): UAObjectType => {
      const type = addressSpace.findObjectType(name, addressSpace.getNamespaceIndex(namespaceUri));
      if (!type) {
        throw new Error(`${this.machineId}: companion type ${name} not found`);
      }
      return type;
    };
    let machine: UAObject;
    if (this.#options.kind === 'machine-tool') {
      machine = find('MachineToolType', MACHINE_TOOL).instantiate({
        namespace: ns,
        browseName: this.#options.name,
        nodeId: `s=${this.machineId}`,
        organizedBy,
        optionals: ['MachineryBuildingBlocks'],
        eventNotifier: EventNotifierFlags.SubscribeToEvents,
      });
    } else {
      machine = ns.addObject({
        browseName: this.#options.name,
        nodeId: `s=${this.machineId}`,
        organizedBy,
        eventNotifier: EventNotifierFlags.SubscribeToEvents,
      });
      find('MachineIdentificationType', MACHINERY).instantiate({
        namespace: ns,
        browseName: { name: 'Identification', namespaceIndex: diNs },
        componentOf: machine,
      });
      ns.addObject({
        browseName: { name: 'MachineryBuildingBlocks', namespaceIndex: machineryNs },
        componentOf: machine,
        typeDefinition: 'FolderType',
      });
    }
    const blocks = machine.getComponentByName(
      'MachineryBuildingBlocks',
      machineryNs,
    ) as UAObject | null;
    if (blocks) {
      const itemState = find('MachineryItemState_StateMachineType', MACHINERY).instantiate({
        namespace: ns,
        browseName: { name: 'MachineryItemState', namespaceIndex: machineryNs },
        componentOf: blocks,
      });
      const operationMode = find('MachineryOperationModeStateMachineType', MACHINERY).instantiate({
        namespace: ns,
        browseName: { name: 'MachineryOperationMode', namespaceIndex: machineryNs },
        componentOf: blocks,
      });
      this.#itemState = promoteToStateMachine(itemState);
      this.#operationMode = promoteToStateMachine(operationMode);
      this.#itemState.setState('NotAvailable');
      this.#operationMode.setState('None');
    }
    const identification = machine.getComponentByName('Identification', diNs) as UAObject | null;
    const setProperty = (name: string, namespaceIndex: number, value: VariantOptions): void => {
      const property = identification?.getPropertyByName(name, namespaceIndex);
      property?.setValueFromSource(value);
    };
    setProperty('Manufacturer', diNs, {
      dataType: DataType.LocalizedText,
      value: { text: 'Orbis Components (simulated)' },
    });
    setProperty('ProductInstanceUri', machineryNs, {
      dataType: DataType.String,
      value: `${SHOPFLOOR_NAMESPACE_URI}:${this.machineId}`,
    });
    setProperty('SerialNumber', diNs, {
      dataType: DataType.String,
      value: this.machineId.toUpperCase(),
    });
    return machine;
  }
}
