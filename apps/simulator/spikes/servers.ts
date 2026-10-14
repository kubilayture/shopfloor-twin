import { OPCUAServer, nodesets } from 'node-opcua';

const companion = process.argv.includes('--companion');
const sets = companion
  ? [
      nodesets.standard,
      nodesets.di,
      nodesets.ia,
      nodesets.isa95JobControl,
      nodesets.machinery,
      nodesets.machineryJobs,
      nodesets.machineryResult,
      nodesets.machineTool,
    ]
  : [nodesets.standard];

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`;
const before = process.memoryUsage().rss;
const t0 = performance.now();
const servers: OPCUAServer[] = [];
for (let i = 0; i < 5; i++) {
  const server = new OPCUAServer({
    port: 4841 + i,
    nodeset_filename: sets,
    buildInfo: { productName: `spike-${String(i)}` },
  });
  await server.initialize();
  const addressSpace = server.engine.addressSpace;
  if (!addressSpace) throw new Error('no address space');
  const ns = addressSpace.getOwnNamespace();
  if (companion) {
    const mtNs = addressSpace.getNamespaceIndex('http://opcfoundation.org/UA/MachineTool/');
    const machineToolType = addressSpace.findObjectType('MachineToolType', mtNs);
    const machines = addressSpace.findNode(
      'ns=' +
        String(addressSpace.getNamespaceIndex('http://opcfoundation.org/UA/Machinery/')) +
        ';i=1001',
    );
    if (!machineToolType) throw new Error('MachineToolType not found');
    const machine = machineToolType.instantiate({
      browseName: `CNC-0${String(i + 1)}`,
      organizedBy: machines ?? addressSpace.rootFolder.objects,
    });
    if (i === 0) {
      const children = machine
        .getComponents()
        .map((c) => c.browseName.name)
        .concat(machine.getProperties().map((p) => p.browseName.name));
      console.log('MachineToolType instance children:', children.join(', '));
    }
  } else {
    const machine = ns.addObject({
      browseName: `CNC-0${String(i + 1)}`,
      organizedBy: addressSpace.rootFolder.objects,
    });
    ns.addVariable({
      componentOf: machine,
      browseName: 'State',
      dataType: 'String',
      value: { dataType: 'String', value: 'Off' },
    });
  }
  await server.start();
  servers.push(server);
}
const t1 = performance.now();
global.gc?.();
console.log(
  `${companion ? 'companion' : 'project'} model: 5 servers started in ${(t1 - t0).toFixed(0)} ms; RSS ${mb(process.memoryUsage().rss)} (+${mb(process.memoryUsage().rss - before)}), heap ${mb(process.memoryUsage().heapUsed)}`,
);
await Promise.all(servers.map((s) => s.shutdown(0)));
