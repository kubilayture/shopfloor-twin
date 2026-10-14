export { Machine } from './machine.ts';
export type { StateChange, StateDurations } from './machine.ts';
export {
  IllegalTransitionError,
  MACHINE_STATES,
  TRANSITIONS,
  canTransition,
} from './machine-state.ts';
export type { MachineState } from './machine-state.ts';
