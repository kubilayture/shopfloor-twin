import { OPCUAServer, nodesets } from 'node-opcua';
const server = new OPCUAServer({
  port: 4871,
  nodeset_filename: [
    nodesets.standard,
    nodesets.di,
    nodesets.ia,
    nodesets.isa95JobControl,
    nodesets.machinery,
    nodesets.machineryJobs,
    nodesets.machineryResult,
    nodesets.machineTool,
  ],
});
await server.initialize();
const as = server.engine.addressSpace;
if (!as) throw new Error('x');
const mNs = as.getNamespaceIndex('http://opcfoundation.org/UA/Machinery/');
const mtNs = as.getNamespaceIndex('http://opcfoundation.org/UA/MachineTool/');
const show = (name: string, ns: number) => {
  const t = as.findObjectType(name, ns);
  if (!t) {
    console.log(name, 'NOT FOUND');
    return;
  }
  const kids = [...t.getComponents(), ...t.getProperties()].map(
    (c) => `${c.browseName.toString()}${c.modellingRule ? '(' + c.modellingRule + ')' : ''}`,
  );
  console.log(name, '->', kids.join(', '));
};
show('MachineToolType', mtNs);
show('MachineToolIdentificationType', mtNs);
show('MonitoringType', mtNs);
show('MachineToolType', mtNs);
show('MachineryItemState_StateMachineType', mNs);
show('MachineryOperationModeStateMachineType', mNs);
show('MachineIdentificationType', mNs);
show('MachineryBuildingBlocksType', mNs);
show('MachineToolMonitoringType', mtNs);
const machines = as.findNode(`ns=${mNs};i=1001`);
console.log('Machines folder:', machines?.browseName.toString());
await server.shutdown(0);
