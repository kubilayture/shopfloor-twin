import {
  MES_API_LIMITS,
  NOTE_CATEGORIES,
  type HandoverNoteDto,
  type ShiftReportDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type Ref } from 'react';
import { createNote, editNote, getNoteAudit, getShiftNotes, type ShiftRef } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { useCan, useUnsavedDraft } from '../auth/auth.tsx';
import { QueryError } from '../components/query-error.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { Checkbox, Select, Textarea } from '../components/ui/controls.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { PlantTime } from '../components/ui/format.tsx';
import { Icon } from '../components/ui/icons.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import {
  CATEGORY_LABELS,
  NOTE_LIMIT,
  draftOf,
  isStaleDraft,
  mergeNotes,
  noteFailure,
  type NoteCategory,
  type NoteDraft,
  type NoteFailure,
} from '../domain/shifts.ts';
import { upsertNote, upsertShift } from '../live/live-cache.ts';
import { useLiveShifts } from '../live/live-context.tsx';

type Message = NoteFailure | { readonly kind: 'saved'; readonly text: string };

/**
 * A write's result, inline where the test reads it (design system 4.10: `new-note-message` stays
 * inline): saved is a polite `ok` callout, a refusal an `alarm` alert.
 */
function MessageText({ message, testId }: { readonly message: Message; readonly testId: string }) {
  const saved = message.kind === 'saved';
  return (
    <Callout
      tone={saved ? 'ok' : 'alarm'}
      role={saved ? 'status' : 'alert'}
      data-testid={testId}
      data-kind={message.kind}
    >
      {message.text}
    </Callout>
  );
}

function CategorySelect({
  value,
  onChange,
}: {
  readonly value: NoteCategory;
  readonly onChange: (value: NoteCategory) => void;
}) {
  return (
    <Select
      label="Category"
      name="category"
      data-testid="note-category"
      value={value}
      fieldClassName="max-w-xs"
      onChange={(event) => {
        const next = NOTE_CATEGORIES.find((category) => category === event.target.value);
        if (next) onChange(next);
      }}
    >
      {NOTE_CATEGORIES.map((category) => (
        <option key={category} value={category}>
          {CATEGORY_LABELS[category]}
        </option>
      ))}
    </Select>
  );
}

function NoteText({
  value,
  onChange,
  error,
  inputRef,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error?: string | undefined;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <Textarea
      ref={inputRef}
      label="Note"
      name="text"
      data-testid="note-text-input"
      value={value}
      rows={4}
      max={MES_API_LIMITS.noteText}
      hint="Shown as plain text."
      error={error}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

/** What the forms check before sending (the shared schema checks again). */
function problems(text: string): string[] {
  const found: string[] = [];
  if (text.trim() === '') found.push('Write the note first.');
  return found;
}

function NewNoteForm({
  shift,
  full,
  onSaved,
}: {
  readonly shift: ShiftRef;
  readonly full: boolean;
  readonly onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<NoteCategory>('general');
  const [text, setText] = useState('');
  const [message, setMessage] = useState<Message | undefined>(undefined);
  useUnsavedDraft(text.trim() !== '');
  const create = useMutation({
    mutationFn: () => createNote(shift, { text, category }),
    onSuccess: (result) => {
      upsertNote(queryClient, result.note);
      upsertShift(queryClient, result.shift);
      setText('');
      setCategory('general');
      setMessage({ kind: 'saved', text: `Note added (version ${String(result.note.version)}).` });
      onSaved();
    },
    onError: (error) => {
      const failure = noteFailure(error);
      setMessage(failure);
      if (failure.kind === 'limit') onSaved();
    },
  });
  const invalid = message?.kind === 'invalid';
  return (
    <Card padding="compact" className="print:hidden">
      <form
        noValidate
        aria-labelledby="new-note-title"
        data-testid="new-note"
        className="flex flex-col gap-3 print:hidden"
        onSubmit={(event) => {
          event.preventDefault();
          const found = problems(text);
          if (found.length > 0) {
            setMessage({ kind: 'invalid', text: found.join(' ') });
            return;
          }
          setMessage(undefined);
          create.mutate();
        }}
      >
        <h3 id="new-note-title" className="text-base font-semibold text-ink">
          New note
        </h3>
        <CategorySelect value={category} onChange={setCategory} />
        <NoteText
          value={text}
          onChange={setText}
          error={invalid ? 'The note is empty.' : undefined}
        />
        {full ? (
          <Callout tone="neutral" role="status" data-testid="note-limit">
            This shift has {NOTE_LIMIT} notes, the most allowed: edit an existing note instead.
          </Callout>
        ) : null}
        {message ? <MessageText message={message} testId="new-note-message" /> : null}
        <div>
          <Button
            type="submit"
            variant="primary"
            data-testid="add-note"
            loading={create.isPending}
            disabled={full}
          >
            Add note
          </Button>
        </div>
      </form>
    </Card>
  );
}

function NoteEditor({
  note,
  shift,
  onClose,
  onSaved,
}: {
  readonly note: HandoverNoteDto;
  readonly shift: ShiftRef;
  readonly onClose: (saved?: string) => void;
  readonly onSaved: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  // The draft keeps the version it started from; once the note moves on it is stale.
  const [draft, setDraft] = useState<NoteDraft>(() => draftOf(note));
  // What the draft started from (or was reloaded to): unsaved while the draft differs from it.
  const [origin, setOrigin] = useState<NoteDraft>(draft);
  useUnsavedDraft(
    draft.text !== origin.text ||
      draft.category !== origin.category ||
      draft.retracted !== origin.retracted,
  );
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const text = useRef<HTMLTextAreaElement>(null);
  const stale = isStaleDraft(draft, note);
  useEffect(() => {
    const area = text.current;
    if (!area) return;
    area.focus();
    // The caret after the text, where an addition goes (not before it).
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);
  const save = useMutation({
    mutationFn: (from: NoteDraft) =>
      editNote(shift, note.id, {
        text: from.text,
        category: from.category,
        retracted: from.retracted,
        version: from.version,
      }),
    onSuccess: (result) => {
      upsertNote(queryClient, result.note);
      upsertShift(queryClient, result.shift);
      void onSaved();
      onClose(`Saved (version ${String(result.note.version)}).`);
    },
    onError: async (error) => {
      const failure = noteFailure(error);
      setMessage(failure);
      // A stale version: read the notes again, so the newer one shows and the draft is stale.
      if (failure.kind === 'stale') await onSaved();
    },
  });
  return (
    <form
      noValidate
      aria-label={`Edit note ${String(note.id)}`}
      data-testid={`note-editor-${String(note.id)}`}
      data-version={String(draft.version)}
      className="mt-3 flex flex-col gap-3 border-t border-line-subtle pt-3 print:hidden"
      onSubmit={(event) => {
        event.preventDefault();
        if (stale) return;
        const found = problems(draft.text);
        if (found.length > 0) {
          setMessage({ kind: 'invalid', text: found.join(' ') });
          return;
        }
        setMessage(undefined);
        save.mutate(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <CategorySelect
        value={draft.category}
        onChange={(category) => {
          setDraft((current) => ({ ...current, category }));
        }}
      />
      <NoteText
        inputRef={text}
        value={draft.text}
        error={message?.kind === 'invalid' ? 'The note is empty.' : undefined}
        onChange={(value) => {
          setDraft((current) => ({ ...current, text: value }));
        }}
      />
      {/*
       * No confirmation (design system 4.9): a retraction is a checkbox of the edit form, sent
       * only by "Save note", undone by unticking it, and every version stays in its history.
       */}
      <Checkbox
        name="retracted"
        label="Retracted"
        hint="A retracted note stays, struck through, with every version in its history; untick to restore it."
        data-testid="note-retracted"
        checked={draft.retracted}
        onChange={(event) => {
          const retracted = event.target.checked;
          setDraft((current) => ({ ...current, retracted }));
        }}
      />
      {stale ? (
        <Callout
          tone="warn"
          role="alert"
          data-testid="note-stale"
          data-kind="stale"
          data-version={String(note.version)}
          title="This note changed while you were editing it"
        >
          <p>
            {note.author} saved version {note.version} of this note while you were editing version{' '}
            {draft.version}. Your draft is not sent, so their edit is not overwritten. Copy what you
            need, then reload the note and edit again.
          </p>
          <Button
            size="sm"
            data-testid="reload-note"
            className="mt-2"
            onClick={() => {
              setDraft(draftOf(note));
              setOrigin(draftOf(note));
              setMessage(undefined);
              text.current?.focus();
            }}
          >
            Reload the note
          </Button>
        </Callout>
      ) : null}
      {message ? <MessageText message={message} testId="note-message" /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          data-testid="save-note"
          loading={save.isPending}
          disabled={stale}
        >
          Save note
        </Button>
        <Button
          data-testid="cancel-note"
          onClick={() => {
            onClose();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NoteHistory({
  note,
  shift,
}: {
  readonly note: HandoverNoteDto;
  readonly shift: ShiftRef;
}) {
  const audit = useQuery({
    queryKey: queryKeys.noteAudit(note.id, note.version),
    queryFn: ({ signal }) => getNoteAudit(shift, note.id, signal),
  });
  return (
    <div data-testid={`note-history-${String(note.id)}`} className="mt-3 print:hidden">
      {audit.isPending ? <Skeleton shape="text" rows={2} label="Loading the history…" /> : null}
      {audit.isError ? (
        <QueryError
          what="the note's history"
          error={audit.error}
          onRetry={() => void audit.refetch()}
        />
      ) : null}
      <ol className="flex flex-col gap-2 text-sm" aria-label={`History of note ${String(note.id)}`}>
        {audit.data?.entries.map((entry) => (
          <li
            key={entry.id}
            data-testid="note-history-entry"
            data-version={String(entry.version)}
            data-action={entry.action}
            className="rounded-md border border-line-subtle bg-surface-sunken p-3"
          >
            <p className="text-ink-secondary">
              <span className="font-medium text-ink">Version {entry.version}</span>,{' '}
              {entry.action === 'created' ? 'created' : 'edited'} by {entry.actor}
              {entry.authenticated ? '' : ' (not authenticated)'} at{' '}
              <PlantTime at={entry.plantAt} />
              {entry.requestId ? (
                <>
                  {' '}
                  · request <Code>{entry.requestId}</Code>
                </>
              ) : null}
            </p>
            <p className="text-ink-secondary">
              {CATEGORY_LABELS[entry.after.category]}
              {entry.after.retracted ? ', retracted' : ''}
            </p>
            <p className="mt-1 break-words whitespace-pre-wrap text-ink">{entry.after.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function NoteItem({
  note,
  shift,
  onSaved,
}: {
  readonly note: HandoverNoteDto;
  readonly shift: ShiftRef;
  readonly onSaved: () => Promise<void>;
}) {
  const canWrite = useCan('note:write');
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const editButton = useRef<HTMLButtonElement>(null);
  const id = String(note.id);
  return (
    <li
      data-testid={`note-${id}`}
      data-version={String(note.version)}
      data-retracted={String(note.retracted)}
      data-category={note.category}
      className="report-section rounded-lg border border-line bg-surface p-4"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Badge tone="neutral" variant="outline">
          {CATEGORY_LABELS[note.category]}
        </Badge>
        {note.retracted ? (
          <Badge tone="neutral" variant="outline" data-testid={`note-retracted-${id}`}>
            Retracted
          </Badge>
        ) : null}
        {/* Who and when (design system 6.2: plant time needs no label); never a typed name (#170). */}
        <span className="text-ink-secondary">
          By {note.author}
          {note.author === note.createdBy ? '' : ` (written by ${note.createdBy})`} · version{' '}
          {note.version} · <PlantTime at={note.updatedPlantAt} />
        </span>
      </p>
      <p
        data-testid={`note-text-${id}`}
        className={`mt-2 break-words whitespace-pre-wrap ${note.retracted ? 'text-ink-secondary line-through' : 'text-ink'}`}
      >
        {note.text}
      </p>
      {saved && !editing ? (
        <p
          role="status"
          data-testid={`note-saved-${id}`}
          className="mt-2 flex items-center gap-1 text-sm text-ok-ink"
        >
          <Icon name="check" size={16} />
          {saved}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2 print:hidden">
        {canWrite && !editing ? (
          <Button
            ref={editButton}
            size="sm"
            data-testid={`edit-note-${id}`}
            aria-label={`Edit note ${id}`}
            onClick={() => {
              setSaved(undefined);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          data-testid={`note-history-toggle-${id}`}
          aria-expanded={history}
          aria-label={`${history ? 'Hide history' : 'History'} of note ${id}`}
          onClick={() => {
            setHistory((open) => !open);
          }}
        >
          {history ? 'Hide history' : 'History'}
        </Button>
      </div>
      {canWrite && editing ? (
        <NoteEditor
          note={note}
          shift={shift}
          onSaved={onSaved}
          onClose={(text) => {
            setEditing(false);
            setSaved(text);
            requestAnimationFrame(() => editButton.current?.focus());
          }}
        />
      ) : null}
      {history ? <NoteHistory note={note} shift={shift} /> : null}
    </li>
  );
}

/** The handover notes of the report's instance, with the editor (#146; UX-5b, #327). */
export function HandoverNotes({
  report,
  shift,
}: {
  readonly report: ShiftReportDto;
  readonly shift: ShiftRef & { readonly epoch: number };
}) {
  const queryClient = useQueryClient();
  const notesKey = queryKeys.shiftNotes(report.key, report.epoch);
  const read = useQuery({
    queryKey: notesKey,
    queryFn: ({ signal }) => getShiftNotes(shift, signal),
  });
  const pushed = useLiveShifts()?.notes;
  const notes = mergeNotes(
    [...report.notes, ...(read.data?.notes ?? [])],
    pushed,
    report.epoch,
    report.key,
  );
  const canWrite = useCan('note:write');
  const onSaved = async () => {
    await queryClient.refetchQueries({ queryKey: notesKey });
  };
  return (
    <Section
      id="handover-title"
      title="Handover notes"
      testId="handover-notes"
      data-count={String(notes.length)}
      description={
        <span className="print:hidden">
          Written from the shift’s start until the end of the following shift. A wrong note is
          retracted, never deleted; every version stays in its history.
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {read.isError ? (
          <QueryError what="the notes" error={read.error} onRetry={() => void read.refetch()} />
        ) : null}
        {notes.length > 0 ? (
          <ol className="flex flex-col gap-3" aria-label="Notes">
            {notes.map((note) => (
              <NoteItem key={note.id} note={note} shift={shift} onSaved={onSaved} />
            ))}
          </ol>
        ) : (
          <Card padding="compact">
            <EmptyState
              size="inline"
              icon="info"
              title="No handover note for this shift"
              testId="notes-empty"
            />
          </Card>
        )}
        {canWrite ? (
          <NewNoteForm
            shift={shift}
            full={notes.length >= NOTE_LIMIT}
            onSaved={() => void onSaved()}
          />
        ) : (
          <Callout tone="neutral" data-testid="notes-read-only" className="print:hidden">
            Your role cannot write handover notes: they are shown read-only.
          </Callout>
        )}
      </div>
    </Section>
  );
}
