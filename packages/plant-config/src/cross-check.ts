import type { PlantConfig } from './schema.ts';

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

const minutesOfDay = (hhmm: string): number => {
  const [hours = 0, minutes = 0] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
};

const DAY = 24 * 60;

const offsetInShift = (start: string, time: string): number =>
  (minutesOfDay(time) - minutesOfDay(start) + DAY) % DAY;

const shiftLength = (start: string, end: string): number => offsetInShift(start, end) || DAY;

export function crossCheck(config: PlantConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const report = (file: string, path: string, message: string): void => {
    issues.push({ file, path, message });
  };

  const operations = config.products.operations;
  const allEquipment = config.plant.areas.flatMap((area) =>
    area.workCenters.flatMap((workCenter) => workCenter.equipment),
  );
  const equipmentIds = new Set<string>();
  allEquipment.forEach((item, index) => {
    if (equipmentIds.has(item.id)) {
      report('plant', `equipment[${String(index)}].id`, `duplicate equipment id "${item.id}"`);
    }
    equipmentIds.add(item.id);
    if (!operations.includes(item.operation)) {
      report('plant', `${item.id}.operation`, `unknown operation "${item.operation}"`);
    }
  });

  allEquipment
    .filter((item) => item.requiresOperator)
    .filter((item) => !config.operators.operators.some((op) => op.skills.includes(item.id)))
    .forEach((item) => {
      report('operators', 'operators', `no operator is qualified for "${item.id}"`);
    });

  config.plant.buffers.forEach((buffer, index) => {
    const from = operations.indexOf(buffer.from);
    if (from < 0 || operations[from + 1] !== buffer.to) {
      report(
        'plant',
        `buffers[${String(index)}]`,
        `buffer ${buffer.from} → ${buffer.to} does not join two consecutive operations`,
      );
    }
  });

  const productIds = new Set(config.products.products.map((product) => product.id));
  const materials = new Set<string>();
  for (const product of config.products.products) {
    materials.add(product.blank);
    product.components.forEach((component) => materials.add(component));
    product.reworkComponents
      .filter((component) => !product.components.includes(component))
      .forEach((component) => {
        report(
          'products',
          `${product.id}.reworkComponents`,
          `"${component}" is not a component of ${product.id}`,
        );
      });
    for (const op of operations) {
      if (product.idealCycleSeconds[op] === undefined) {
        report('products', `${product.id}.idealCycleSeconds`, `missing ideal cycle time for ${op}`);
      }
    }
  }

  const shiftIds = new Set(config.shifts.shifts.map((shift) => shift.id));
  for (const shift of config.shifts.shifts) {
    if (!shift.break) {
      continue;
    }
    const length = shiftLength(shift.start, shift.end);
    const breakEnd = offsetInShift(shift.start, shift.break.start) + shift.break.minutes;
    if (breakEnd > length) {
      report('shifts', `${shift.id}.break`, 'break does not fit inside the shift');
    }
  }
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(config.shifts.timeZone);
  } catch {
    report('shifts', 'timeZone', `unknown time zone "${config.shifts.timeZone}"`);
  }

  config.operators.operators.forEach((operator) => {
    if (!shiftIds.has(operator.shift)) {
      report('operators', `${operator.id}.shift`, `unknown shift "${operator.shift}"`);
    }
    operator.skills
      .filter((skill) => !equipmentIds.has(skill))
      .forEach((skill) => {
        report('operators', `${operator.id}.skills`, `unknown station "${skill}"`);
      });
  });

  Object.keys(config.failures.equipment)
    .filter((key) => !equipmentIds.has(key))
    .forEach((key) => {
      report('failures', `equipment.${key}`, `unknown equipment "${key}"`);
    });

  operations
    .filter((op) => config.process.cycleTimeCv[op] === undefined)
    .forEach((op) => {
      report('process', 'cycleTimeCv', `missing coefficient of variation for ${op}`);
    });
  if (!operations.includes(config.products.componentsOperation)) {
    report(
      'products',
      'componentsOperation',
      `unknown operation "${config.products.componentsOperation}"`,
    );
  }
  for (const key of ['operation', 'reworkOperation'] as const) {
    const op = config.process.leakTest[key];
    if (!operations.includes(op)) {
      report('process', `leakTest.${key}`, `unknown operation "${op}"`);
    }
  }
  const { spindleLoad, coolant } = config.process.processValues;
  for (const [path, resolution] of [
    ['spindleLoad.resolution', spindleLoad.resolution],
    ['coolant.resolution', coolant.resolution],
    ['leakTest.resolution', config.process.leakTest.resolution],
  ] as const) {
    const exponent = Math.log10(resolution);
    if (Math.abs(exponent - Math.round(exponent)) > 1e-9) {
      report('process', path, `resolution must be a power of ten, got ${String(resolution)}`);
    }
  }
  config.process.processValues.machines
    .filter((machine) => !equipmentIds.has(machine))
    .forEach((machine) => {
      report('process', 'processValues.machines', `unknown equipment "${machine}"`);
    });
  const curve = config.process.tool.defectProbability;
  const wears = curve.map((point) => point.wear);
  if (
    wears[0] !== 0 ||
    wears.at(-1) !== 1 ||
    wears.some((w, i) => i > 0 && w <= (wears[i - 1] ?? 0))
  ) {
    report('process', 'tool.defectProbability', 'wear points must rise strictly from 0 to 1');
  }

  const lotIds = new Set<string>();
  for (const lot of config.stock.lots) {
    if (lotIds.has(lot.id)) {
      report('stock', `${lot.id}.id`, `duplicate lot id "${lot.id}"`);
    }
    lotIds.add(lot.id);
  }

  config.stock.lots
    .filter((lot) => !materials.has(lot.material))
    .forEach((lot) => {
      report('stock', `${lot.id}.material`, `material "${lot.material}" is used by no product`);
    });

  const firstOperation = operations[0];
  for (const [machine, campaigns] of Object.entries(config.schedule.machines)) {
    const item = allEquipment.find((candidate) => candidate.id === machine);
    if (item?.operation !== firstOperation) {
      report(
        'schedule',
        `machines.${machine}`,
        `"${machine}" is not a ${String(firstOperation)} machine`,
      );
    }
    campaigns
      .filter((campaign) => !productIds.has(campaign.product))
      .forEach((campaign) => {
        report('schedule', `machines.${machine}`, `unknown product "${campaign.product}"`);
      });
  }

  return issues;
}
