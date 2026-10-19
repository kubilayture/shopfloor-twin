// The gateway's end-to-end support lives in `@shopfloor/test-kit` since #174, which shares it with
// the MES's orders end to end: the simulator and the gateway as processes, and TCP proxies. Ports
// are chosen at runtime and timing bounds widen with measured lag (#212).
export { TEST_PASSWORDS, freePort, startBroker } from '@shopfloor/test-kit/broker';
export {
  TcpProxy,
  freeSimulatorPorts,
  opcuaProxies,
  startGateway,
  startSimulator,
} from '@shopfloor/test-kit/processes';
export type {
  RunningGateway,
  RunningSimulator,
  SimEvent,
  SimulatorPorts,
} from '@shopfloor/test-kit/processes';
export { timed } from '@shopfloor/test-kit/timing';
export { installGatewayPki } from '@shopfloor/test-kit/opcua-pki';
