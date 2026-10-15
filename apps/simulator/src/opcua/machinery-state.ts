import type { MachineState } from '../plant/machine-state.ts';

export type MachineryItemState = 'NotAvailable' | 'OutOfService' | 'Executing' | 'NotExecuting';
export type MachineryOperationMode = 'None' | 'Setup' | 'Processing' | 'Maintenance';

const ITEM_STATE: Record<MachineState, MachineryItemState> = {
  Off: 'NotAvailable',
  Down: 'OutOfService',
  Maintenance: 'OutOfService',
  Running: 'Executing',
  Idle: 'NotExecuting',
  Stopped: 'NotExecuting',
  Starved: 'NotExecuting',
  Blocked: 'NotExecuting',
  Setup: 'NotExecuting',
  PlannedStop: 'NotExecuting',
};

export const machineryItemState = (state: MachineState): MachineryItemState => ITEM_STATE[state];

export function machineryOperationMode(state: MachineState): MachineryOperationMode {
  switch (state) {
    case 'Off':
      return 'None';
    case 'Setup':
      return 'Setup';
    case 'Maintenance':
      return 'Maintenance';
    case 'Idle':
    case 'Running':
    case 'Stopped':
    case 'Starved':
    case 'Blocked':
    case 'Down':
    case 'PlannedStop':
      return 'Processing';
  }
}
