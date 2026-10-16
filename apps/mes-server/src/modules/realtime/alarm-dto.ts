/**
 * Alarm answers as JSON (#142): fractions as `num/den` strings with their four-decimal value and
 * times as ISO 8601, in the same shape as the simulator's ground truth (`alarms` of sim-summary/3),
 * so the two compare field by field.
 */
import type { BadActor, FloodEpisode } from '@shopfloor/alarm-core';
import {
  occurrenceId,
  type AlarmComment,
  type AlarmHistoryEntry,
  type AlarmKpiBucket,
  type AlarmOccurrence,
  type AlarmPoint,
  type AlarmShelf,
  type AlarmTransition,
} from '../alarms/index.ts';
import { ratio } from './oee-dto.ts';
import type {
  AlarmCommentDto,
  AlarmHistory,
  AlarmKpiBucketDto,
  AlarmOccurrenceDto,
  AlarmPointDto,
  AlarmShelfDto,
  AlarmTransitionDto,
  BadActorDto,
  FloodEpisodeDto,
} from './schemas.ts';

const iso = (at: number | Date): string => new Date(at).toISOString();

export function occurrenceDto(occurrence: AlarmOccurrence): AlarmOccurrenceDto {
  return {
    id: occurrence.id,
    equipment: occurrence.equipment,
    epoch: occurrence.epoch,
    seq: occurrence.seq,
    code: occurrence.code,
    priority: occurrence.priority,
    defined: occurrence.defined,
    text: occurrence.text,
    severity: occurrence.severity,
    source: occurrence.source,
    raisedAt: iso(occurrence.raisedAt),
    endedAt: occurrence.endedAt && iso(occurrence.endedAt),
    endReason: occurrence.endReason,
    endSeq: occurrence.endSeq,
    active: occurrence.endedAt === null,
    final: occurrence.final,
    state: occurrence.state,
    acknowledged: occurrence.acknowledged && {
      by: occurrence.acknowledged.by,
      at: iso(occurrence.acknowledged.at),
      plantAt: occurrence.acknowledged.plantAt && iso(occurrence.acknowledged.plantAt),
      comment: occurrence.acknowledged.comment,
    },
    shelved: occurrence.shelved,
    comments: occurrence.comments,
  };
}

export const shelfDto = (shelf: AlarmShelf): AlarmShelfDto => ({
  shelved: shelf.shelved,
  version: shelf.version,
  by: shelf.by,
  reason: shelf.reason,
  shelvedAt: shelf.shelvedAt && iso(shelf.shelvedAt),
  epoch: shelf.epoch,
  plantAt: shelf.plantAt && iso(shelf.plantAt),
  until: shelf.until && iso(shelf.until),
  durationMs: shelf.durationMs,
});

export const pointDto = (point: AlarmPoint): AlarmPointDto => ({
  equipment: point.equipment,
  code: point.code,
  defined: point.defined,
  priority: point.priority,
  text: point.text,
  shelf: shelfDto(point.shelf),
  activeOccurrence: point.activeOccurrence,
});

export const commentDto = (comment: AlarmComment): AlarmCommentDto => ({
  id: comment.id,
  text: comment.text,
  actor: comment.actor,
  authenticated: comment.authenticated,
  at: iso(comment.at),
  plantAt: comment.plantAt && iso(comment.plantAt),
  requestId: comment.requestId,
});

export const transitionDto = (entry: AlarmTransition): AlarmTransitionDto => ({
  id: entry.id,
  equipment: entry.equipment,
  code: entry.code,
  occurrence:
    entry.epoch === null || entry.seq === null
      ? null
      : occurrenceId(entry.equipment, entry.epoch, entry.seq),
  action: entry.action,
  before: entry.before,
  after: entry.after,
  actor: entry.actor,
  authenticated: entry.authenticated,
  at: iso(entry.at),
  plantAt: entry.plantAt && iso(entry.plantAt),
  plantEpoch: entry.plantEpoch,
  requestId: entry.requestId,
  version: entry.version,
});

export function historyDto(id: string, entries: readonly AlarmHistoryEntry[]): AlarmHistory {
  return {
    id,
    entries: entries.map((entry) => ({
      source: entry.source,
      transition: entry.transition,
      at: iso(entry.at),
      seq: entry.seq,
      receivedAt: entry.receivedAt && iso(entry.receivedAt),
      protocol: entry.protocol,
      actor: entry.audit?.actor ?? null,
      authenticated: entry.audit?.authenticated ?? null,
      recordedAt: entry.audit ? iso(entry.audit.at) : null,
      requestId: entry.audit?.requestId ?? null,
      auditId: entry.audit?.id ?? null,
      detail: entry.audit?.after ?? null,
    })),
  };
}

export function alarmKpiDto(bucket: AlarmKpiBucket): AlarmKpiBucketDto {
  const { kpis } = bucket;
  return {
    scope: bucket.scope,
    id: bucket.id,
    bucket: bucket.bucket,
    key: bucket.key,
    epoch: bucket.epoch,
    from: iso(kpis.from),
    to: iso(kpis.to),
    raises: kpis.raises,
    byPriority: { ...kpis.byPriority },
    averageRate: ratio(kpis.averageRate),
    windows: kpis.windows,
    peak10: kpis.peak10,
    floodWindows: kpis.floodWindows,
    floods: kpis.floods.map((flood) => ({
      id: flood.id,
      startAt: iso(flood.startAt),
      floodMs: flood.floodMs,
      peak: flood.peak,
      open: flood.open,
      ended:
        flood.ended === null
          ? null
          : {
              endAt: iso(flood.ended.endAt),
              peak: flood.ended.peak,
              raises: flood.ended.raises,
            },
    })),
    floodMs: kpis.floodMs,
    activeAtEnd: kpis.activeAtEnd,
    standing: kpis.standing.map((standing) => ({
      id: occurrenceId(standing.equipment, bucket.epoch, standing.seq),
      equipment: standing.equipment,
      code: standing.code,
      raisedAt: iso(standing.raisedAt),
    })),
    chatteringRaises: kpis.chatteringRaises,
    chatteringPoints: [...kpis.chatteringPoints],
    fleeting: kpis.fleeting,
    fleetingUndecided: kpis.fleetingUndecided,
    activeMs: kpis.activeMs,
    provisional: kpis.provisional,
    final: bucket.final,
    revision: bucket.revision,
    incidents: bucket.incidents,
  };
}

export const floodEpisodeDto = (episode: FloodEpisode): FloodEpisodeDto => ({
  id: episode.id,
  startAt: iso(episode.startAt),
  equipment: episode.equipment,
  code: episode.code,
  endAt: episode.endAt === null ? null : iso(episode.endAt),
  peak: episode.peak,
  raises: episode.raises,
});

export const badActorDto = (actor: BadActor): BadActorDto => ({
  equipment: actor.equipment,
  code: actor.code,
  raises: actor.raises,
  share: ratio(actor.share),
  activeMs: actor.activeMs,
  chatteringRaises: actor.chatteringRaises,
});
