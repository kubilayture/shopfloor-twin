import { describe, expect, it } from 'vitest';
import {
  OPCUA_MACHINES,
  OPCUA_VARIABLES,
  opcuaEndpoint,
  opcuaEventTypeId,
  opcuaNodeId,
  toIndexedNodeId,
} from './opcua.ts';

describe('OPC UA contract', () => {
  it('builds namespace-URI node ids that never depend on a namespace index (ADR-0008)', () => {
    expect(opcuaNodeId('cnc-01', OPCUA_VARIABLES.state)).toBe(
      'nsu=urn:orbis-components:shopfloor-twin;s=cnc-01.ShopFloor.State',
    );
    expect(opcuaEventTypeId('CycleCompleteEventType')).toBe(
      'nsu=urn:orbis-components:shopfloor-twin;s=CycleCompleteEventType',
    );
    expect(opcuaEndpoint('localhost', 4841)).toBe('opc.tcp://localhost:4841');
  });

  it('lists the five OPC UA machines on ports 4841–4845; WSH-01 is Modbus (plan section 3)', () => {
    expect(OPCUA_MACHINES.map((m) => `${m.id}:${String(m.port)}`)).toEqual([
      'cnc-01:4841',
      'cnc-02:4842',
      'asm-01:4843',
      'lkt-01:4844',
      'pck-01:4845',
    ]);
  });

  it('translates a namespace-URI node id into the index a server uses', () => {
    const namespaces = [
      'http://opcfoundation.org/UA/',
      'urn:x',
      'urn:orbis-components:shopfloor-twin',
    ];
    expect(toIndexedNodeId(opcuaNodeId('asm-01', OPCUA_VARIABLES.state), namespaces)).toBe(
      'ns=2;s=asm-01.ShopFloor.State',
    );
    expect(toIndexedNodeId('i=2253', namespaces)).toBe('i=2253');
    expect(() => toIndexedNodeId('nsu=urn:unknown;s=x', namespaces)).toThrow(RangeError);
  });
});
