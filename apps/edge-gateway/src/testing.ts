// The gateway's end-to-end support lives in `@shopfloor/test-kit` since #174, which shares it with
// the MES's orders end to end: the simulator and the gateway as processes, and TCP proxies.
export { TEST_PASSWORDS, freePort, startBroker } from '@shopfloor/test-kit/broker';
export {
  TcpProxy,
  opcuaProxies,
  startGateway,
  startSimulator,
} from '@shopfloor/test-kit/processes';
export type { RunningGateway, RunningSimulator, SimEvent } from '@shopfloor/test-kit/processes';
