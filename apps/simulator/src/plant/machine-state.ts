export const MACHINE_STATES = [
  'Off',
  'Idle',
  'Running',
  'Stopped',
  'Starved',
  'Blocked',
  'Setup',
  'Down',
  'PlannedStop',
  'Maintenance',
] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

export const TRANSITIONS: Readonly<Record<MachineState, readonly MachineState[]>> = {
  Off: ['Idle', 'Maintenance'],
  Idle: ['Running', 'Starved', 'Blocked', 'Setup', 'Down', 'PlannedStop', 'Maintenance', 'Off'],
  Running: ['Idle', 'Stopped', 'Starved', 'Blocked', 'Down', 'PlannedStop'],
  Stopped: ['Running', 'Down', 'PlannedStop'],
  Starved: ['Running', 'Idle', 'Setup', 'Down', 'PlannedStop', 'Off'],
  Blocked: ['Running', 'Idle', 'Down', 'PlannedStop', 'Off'],
  Setup: ['Idle', 'Running', 'Down', 'PlannedStop'],
  Down: ['Idle', 'Running'],
  PlannedStop: ['Idle', 'Running', 'Setup', 'Maintenance', 'Off'],
  Maintenance: ['Idle', 'Off'],
};

export const canTransition = (from: MachineState, to: MachineState): boolean =>
  TRANSITIONS[from].includes(to);

export class IllegalTransitionError extends Error {
  readonly from: MachineState;
  readonly to: MachineState;
  readonly machineId: string;

  constructor(machineId: string, from: MachineState, to: MachineState) {
    super(`${machineId}: illegal transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.machineId = machineId;
    this.from = from;
    this.to = to;
  }
}
