// Spike #71: modbus-serial as Modbus TCP server (simulator) and client (gateway).
// Run: node apps/simulator/spikes/modbus.ts
import Modbus, { ServerTCP } from 'modbus-serial';

// The package's .d.ts uses `export default` in a CommonJS package: TypeScript sees the default import
// as the module namespace, so the class is `.default` (which also works at runtime).
const ModbusRTU = Modbus.default;

const PORT = 5520;
const registers = new Uint16Array(256);
let silent = false;
let requests = 0;

const vector = {
  // The callback form: a silent device simply never calls back. (The synchronous form must return an
  // array; returning a Promise there yields exception 4, found in this spike.)
  getMultipleHoldingRegisters: (
    addr: number,
    length: number,
    _unitID: number,
    cb: (err: Error | null, values: number[]) => void,
  ): void => {
    requests++;
    if (silent) return;
    if (addr + length > registers.length) {
      cb(Object.assign(new Error('illegal address'), { modbusErrorCode: 2 }), []);
      return;
    }
    cb(null, Array.from(registers.subarray(addr, addr + length)));
  },
  getCoil: (addr: number): boolean => addr === 0,
};

function startServer(): Promise<InstanceType<typeof ServerTCP>> {
  return new Promise((resolve) => {
    const server = new ServerTCP(vector, { host: '127.0.0.1', port: PORT, unitID: 1 });
    server.on('initialized', () => {
      resolve(server);
    });
    server.on('socketError', (error: unknown) => {
      console.log('socketError', String(error));
    });
  });
}

const closeServer = (server: InstanceType<typeof ServerTCP>) =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

let server = await startServer();
const client = new ModbusRTU();
await client.connectTCP('127.0.0.1', { port: PORT });
client.setID(1);
client.setTimeout(500);

// 1. Throughput and latency of a 64-register block read, values changing between polls.
const latencies: number[] = [];
for (let i = 0; i < 2000; i++) {
  registers[0] = i & 0xffff;
  registers[1] = (100_000 + i) >>> 16;
  registers[2] = (100_000 + i) & 0xffff;
  const t = performance.now();
  const result = await client.readHoldingRegisters(0, 64);
  latencies.push(performance.now() - t);
  const counter = ((result.data[1] ?? 0) << 16) | (result.data[2] ?? 0);
  if (result.data[0] !== (i & 0xffff) || counter !== 100_000 + i)
    throw new Error(`mismatch at ${i}`);
}
latencies.sort((a, b) => a - b);
console.log(
  `1. 2000 reads of 64 registers: median ${latencies[1000]?.toFixed(3)} ms, p99 ${latencies[1980]?.toFixed(3)} ms; 32-bit values intact`,
);

// 2. Exception response for an illegal address.
try {
  await client.readHoldingRegisters(250, 10);
  console.log('2. illegal address: no error (unexpected)');
} catch (error) {
  console.log(
    '2. illegal address:',
    (error as { modbusCode?: number; message: string }).modbusCode,
    (error as Error).message,
  );
}

// 3. Coils.
const coils = await client.readCoils(0, 2);
console.log('3. coils', coils.data.slice(0, 2));

// 4. Silent device: the client times out, the connection stays usable afterwards.
silent = true;
const t4 = performance.now();
try {
  await client.readHoldingRegisters(0, 4);
  console.log('4. silent device: answered (unexpected)');
} catch (error) {
  console.log(
    `4. silent device: ${(error as Error).message} after ${(performance.now() - t4).toFixed(0)} ms`,
  );
}
silent = false;
try {
  const after = await client.readHoldingRegisters(0, 4);
  console.log('4b. after silence, next read ok:', after.data.length === 4);
} catch (error) {
  console.log(
    '4b. after silence, next read failed:',
    (error as Error).message,
    'isOpen',
    client.isOpen,
  );
}

// 5. Server restart: detect the close, reconnect.
let closed = false;
client.on('close', () => {
  closed = true;
});
await closeServer(server);
await new Promise((r) => setTimeout(r, 200));
console.log('5. server closed; client saw close:', closed, 'isOpen:', client.isOpen);
try {
  await client.readHoldingRegisters(0, 4);
  console.log('5b. read while server down: ok (unexpected)');
} catch (error) {
  console.log('5b. read while server down:', (error as Error).message);
}
server = await startServer();
const reconnect = new ModbusRTU();
await reconnect.connectTCP('127.0.0.1', { port: PORT });
reconnect.setID(1);
reconnect.setTimeout(500);
console.log(
  '5c. new client after restart:',
  (await reconnect.readHoldingRegisters(0, 4)).data.length === 4,
);

// 6. Two clients at once.
const other = new ModbusRTU();
await other.connectTCP('127.0.0.1', { port: PORT });
other.setID(1);
const both = await Promise.all([
  reconnect.readHoldingRegisters(0, 8),
  other.readHoldingRegisters(8, 8),
]);
console.log(
  '6. two clients concurrently:',
  both.map((b) => b.data.length),
);
console.log('requests served:', requests);

reconnect.close(() => undefined);
other.close(() => undefined);
client.close(() => undefined);
await closeServer(server);
