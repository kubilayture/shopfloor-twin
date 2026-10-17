/**
 * DTOs of the shifts API (#144, ADR-0025): shift instances, the shift report and handover notes,
 * shaped by the shared schemas of `@shopfloor/contracts` (ADR-0020).
 */
import type { CrewMemberDto } from '@shopfloor/contracts/mes-api';
import type {
  CrewRecord,
  HandoverAuditEntry,
  HandoverNote,
  ShiftRecord,
  ShiftReport,
} from '../shifts/index.ts';
import type { OeeBucket } from '../oee/index.ts';
import { alarmKpiDto, badActorDto, operatorBucketDto } from './alarm-dto.ts';
import { bucketDto, recordDto } from './oee-dto.ts';
import type {
  HandoverAuditEntryDto,
  HandoverNoteDto,
  ShiftOee,
  ShiftRecordDto,
  ShiftReportDto,
} from './schemas.ts';

const iso = (date: Date | number): string => new Date(date).toISOString();

/** `GET /shifts/{date}/{shift}/oee`'s body; the report embeds the very same. */
export function shiftOeeDto(
  bucket: { readonly key: string; readonly start: number; readonly end: number },
  result: { readonly equipment: readonly OeeBucket[]; readonly workCenters: readonly OeeBucket[] },
): ShiftOee {
  return {
    shiftKey: bucket.key,
    start: iso(bucket.start),
    end: iso(bucket.end),
    equipment: result.equipment.map(bucketDto),
    workCenters: result.workCenters.map(bucketDto),
  };
}

export const shiftRecordDto = (record: ShiftRecord): ShiftRecordDto => ({
  key: record.key,
  date: record.date,
  shift: record.shift,
  epoch: record.epoch,
  start: iso(record.start),
  end: iso(record.end),
  breaks: record.breaks.map((b) => ({ start: iso(b.start), end: iso(b.end) })),
  status: record.status,
  final: record.status === 'final',
  finalAt: record.finalAt && iso(record.finalAt),
  revision: { ...record.revision },
});

export const handoverNoteDto = (note: HandoverNote): HandoverNoteDto => ({
  id: note.id,
  epoch: note.epoch,
  shiftKey: note.shiftKey,
  category: note.category,
  text: note.text,
  retracted: note.retracted,
  createdBy: note.createdBy,
  author: note.author,
  version: note.version,
  createdAt: iso(note.createdAt),
  createdPlantAt: iso(note.createdPlantAt),
  updatedAt: iso(note.updatedAt),
  updatedPlantAt: iso(note.updatedPlantAt),
});

export const handoverAuditDto = (entry: HandoverAuditEntry): HandoverAuditEntryDto => ({
  id: entry.id,
  noteId: entry.noteId,
  action: entry.action,
  before: entry.before && {
    category: entry.before.category as HandoverNoteDto['category'],
    text: entry.before.text,
    retracted: entry.before.retracted,
  },
  after: {
    category: entry.after.category as HandoverNoteDto['category'],
    text: entry.after.text,
    retracted: entry.after.retracted,
  },
  actor: entry.actor,
  authenticated: entry.authenticated,
  at: iso(entry.at),
  plantAt: iso(entry.plantAt),
  requestId: entry.requestId,
  version: entry.version,
});

export const notesDto = (notes: ShiftReport['notes']) =>
  notes.map(({ note, history }) => ({
    note: handoverNoteDto(note),
    history: history.map(handoverAuditDto),
  }));

/** The shift report (ADR-0025). `generatedAt`: wall time of the read. */
export function shiftReportDto(report: ShiftReport, generatedAt: Date): ShiftReportDto {
  const { instance } = report;
  return {
    ...shiftRecordDto(instance),
    incidents: report.incidents,
    asOf: report.asOf && iso(report.asOf),
    generatedAt: iso(generatedAt),
    oee: shiftOeeDto(
      { key: instance.key, start: instance.start.getTime(), end: instance.end.getTime() },
      report.oee,
    ),
    downtime: {
      availability: { ...report.downtime.pareto.availability },
      reasons: report.downtime.pareto.reasons.map((r) => ({ ...r })),
      microStops: report.downtime.pareto.microStops.map((m) => ({ ...m })),
      records: report.downtime.records,
      uncodedMs: report.downtime.uncodedMs,
      longest: report.downtime.longest.map((record) => recordDto(record, report.asOf ?? undefined)),
    },
    production: {
      machines: report.production.machines.map((m) => ({
        equipment: m.equipment,
        produced: m.produced,
        good: m.good,
        scrap: m.scrap,
        rework: m.rework,
        cycles: m.cycles.map((c) => ({ product: c.product, result: c.result, count: c.count })),
      })),
      finished: { ...report.production.finished },
      scrap: report.production.scrap,
    },
    alarms: {
      scopes: report.alarms.map((s) => ({
        scope: s.scope.scope,
        id: s.scope.id,
        name: s.scope.name,
        kpis: s.kpis && alarmKpiDto(s.kpis),
        badActors: s.badActors.map(badActorDto),
        operator: s.operator && operatorBucketDto(s.operator),
      })),
    },
    notes: notesDto(report.notes),
    crew: report.crew.map(crewDto),
  };
}

/** A crew row (#177): the shift report's crew section and the terminal's. */
export function crewDto(crew: CrewRecord): CrewMemberDto {
  return {
    id: crew.id,
    userId: crew.userId,
    username: crew.username,
    workCenter: crew.workCenter,
    epoch: crew.epoch,
    shiftKey: crew.shiftKey,
    from: iso(crew.from),
    fromPlant: iso(crew.fromPlant),
    to: crew.to === null ? null : iso(crew.to),
    toPlant: crew.toPlant === null ? null : iso(crew.toPlant),
    endReason: crew.endReason,
  };
}
