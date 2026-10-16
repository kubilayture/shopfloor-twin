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

/**
 * Legal transitions. Off, PlannedStop and Maintenance → Down, and Down → Down, are used only by a
 * held failure injection (#140): it takes effect where the machine would enter Running, so the
 * machine goes straight to Down; at the end of a repair it stays Down with the injected code.
 */
export const TRANSITIONS: Readonly<Record<MachineState, readonly MachineState[]>> = {
  Off: ['Idle', 'Running', 'Starved', 'Blocked', 'Setup', 'Down', 'PlannedStop', 'Maintenance'],
  Idle: ['Running', 'Starved', 'Blocked', 'Setup', 'Down', 'PlannedStop', 'Maintenance', 'Off'],
  Running: [
    'Idle',
    'Stopped',
    'Starved',
    'Blocked',
    'Setup',
    'Down',
    'PlannedStop',
    'Maintenance',
    'Off',
  ],
  Stopped: ['Running', 'Idle', 'Down', 'PlannedStop', 'Off'],
  Starved: ['Running', 'Idle', 'Setup', 'Down', 'PlannedStop', 'Maintenance', 'Off'],
  Blocked: ['Running', 'Idle', 'Starved', 'Setup', 'Down', 'PlannedStop', 'Maintenance', 'Off'],
  Setup: ['Idle', 'Running', 'Starved', 'Down', 'PlannedStop', 'Off'],
  Down: ['Idle', 'Running', 'Down', 'PlannedStop', 'Off'],
  PlannedStop: ['Idle', 'Running', 'Starved', 'Blocked', 'Setup', 'Down', 'Maintenance', 'Off'],
  Maintenance: ['Idle', 'Running', 'Starved', 'Down', 'PlannedStop', 'Off'],
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
