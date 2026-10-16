import {
  MES_API_LIMITS,
  NOTE_CATEGORIES,
  type HandoverNoteDto,
  type ShiftReportDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { createNote, editNote, getNoteAudit, getShiftNotes, type ShiftRef } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { QueryError } from '../components/query-error.tsx';
import { useCan, useUnsavedDraft } from '../auth/auth.tsx';
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
import { formatPlantTime } from '../domain/time.ts';
import { upsertNote, upsertShift } from '../live/live-cache.ts';
import { useLiveShifts } from '../live/live-context.tsx';

const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1 text-sm';
const buttonClass =
  'rounded border border-slate-500 bg-white px-3 py-1 text-sm font-medium hover:bg-slate-100 disabled:opacity-50';
const primaryClass =
  'rounded bg-sky-800 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-50';

type Message = NoteFailure | { readonly kind: 'saved'; readonly text: string };

function MessageText({ message, testId }: { readonly message: Message; readonly testId: string }) {
  return (
    <p
      role={message.kind === 'saved' ? 'status' : 'alert'}
      data-testid={testId}
      data-kind={message.kind}
      className={`rounded border p-2 text-sm ${
        message.kind === 'saved'
          ? 'border-emerald-800 bg-emerald-50 text-emerald-950'
          : 'border-red-800 bg-red-50 text-red-950'
      }`}
    >
      {message.text}
    </p>
  );
}

function CategorySelect({
  value,
  onChange,
}: {
  readonly value: NoteCategory;
  readonly onChange: (value: NoteCategory) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        Category
      </label>
      <select
        id={id}
        data-testid="note-category"
        value={value}
        onChange={(event) => {
          const next = NOTE_CATEGORIES.find((category) => category === event.target.value);
          if (next) onChange(next);
        }}
        className={`${inputClass} max-w-xs`}
      >
        {NOTE_CATEGORIES.map((category) => (
          <option key={category} value={category}>
            {CATEGORY_LABELS[category]}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  inputRef,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  const countId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        Note
      </label>
      <textarea
        id={id}
        ref={inputRef}
        data-testid="note-text-input"
        value={value}
        rows={4}
        maxLength={MES_API_LIMITS.noteText}
        aria-describedby={countId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={`${inputClass} w-full`}
      />
      <p id={countId} className="text-xs text-slate-700">
        {value.length} of {MES_API_LIMITS.noteText} characters. Shown as plain text.
      </p>
    </div>
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
  return (
    <form
      noValidate
      aria-label="New handover note"
      data-testid="new-note"
      className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-3 print:hidden"
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
      <h3 className="font-semibold">New note</h3>
      <CategorySelect value={category} onChange={setCategory} />
      <TextInput value={text} onChange={setText} />
      {full ? (
        <p role="status" data-testid="note-limit" className="text-sm text-amber-950">
          This shift has {NOTE_LIMIT} notes, the most allowed: edit an existing note instead.
        </p>
      ) : null}
      {message ? <MessageText message={message} testId="new-note-message" /> : null}
      <div>
        <button
          type="submit"
          data-testid="add-note"
          disabled={create.isPending || full}
          className={primaryClass}
        >
          {create.isPending ? 'Saving…' : 'Add note'}
        </button>
      </div>
    </form>
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
  const retractedId = useId();
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
      className="mt-2 flex flex-col gap-2 border-t border-slate-200 pt-2 print:hidden"
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
      <TextInput
        inputRef={text}
        value={draft.text}
        onChange={(value) => {
          setDraft((current) => ({ ...current, text: value }));
        }}
      />
      <div className="flex items-center gap-2">
        <input
          id={retractedId}
          type="checkbox"
          data-testid="note-retracted"
          checked={draft.retracted}
          onChange={(event) => {
            const retracted = event.target.checked;
            setDraft((current) => ({ ...current, retracted }));
          }}
        />
        <label htmlFor={retractedId} className="text-sm">
          Retracted (a wrong note stays in the history; untick to restore it)
        </label>
      </div>
      {stale ? (
        <div
          role="alert"
          data-testid="note-stale"
          data-kind="stale"
          data-version={String(note.version)}
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          <p>
            {note.author} saved version {note.version} of this note while you were editing version{' '}
            {draft.version}. Your draft is not sent, so their edit is not overwritten. Copy what you
            need, then reload the note and edit again.
          </p>
          <button
            type="button"
            data-testid="reload-note"
            className={`${buttonClass} mt-2`}
            onClick={() => {
              setDraft(draftOf(note));
              setOrigin(draftOf(note));
              setMessage(undefined);
              text.current?.focus();
            }}
          >
            Reload the note
          </button>
        </div>
      ) : null}
      {message ? <MessageText message={message} testId="note-message" /> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="save-note"
          disabled={save.isPending || stale}
          className={primaryClass}
        >
          {save.isPending ? 'Saving…' : 'Save note'}
        </button>
        <button
          type="button"
          data-testid="cancel-note"
          className={buttonClass}
          onClick={() => {
            onClose();
          }}
        >
          Cancel
        </button>
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
    <div data-testid={`note-history-${String(note.id)}`} className="mt-2 print:hidden">
      {audit.isPending ? <p className="text-sm">Loading the history…</p> : null}
      {audit.isError ? (
        <QueryError
          what="the note's history"
          error={audit.error}
          onRetry={() => void audit.refetch()}
        />
      ) : null}
      <ol className="flex flex-col gap-1 text-sm">
        {audit.data?.entries.map((entry) => (
          <li
            key={entry.id}
            data-testid="note-history-entry"
            data-version={String(entry.version)}
            data-action={entry.action}
            className="rounded border border-slate-200 p-2"
          >
            <p>
              Version {entry.version}, {entry.action === 'created' ? 'created' : 'edited'} by{' '}
              {entry.actor}
              {entry.authenticated ? '' : ' (not authenticated)'} at{' '}
              <time dateTime={entry.plantAt}>{formatPlantTime(entry.plantAt)}</time> plant time
              {entry.requestId ? `, request ${entry.requestId}` : ''}
            </p>
            <p className="text-slate-700">
              {CATEGORY_LABELS[entry.after.category]}
              {entry.after.retracted ? ', retracted' : ''}
            </p>
            <p className="whitespace-pre-wrap break-words">{entry.after.text}</p>
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
      className="report-section rounded-lg border border-slate-300 bg-white p-3"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded border border-slate-500 px-1.5 text-xs font-semibold">
          {CATEGORY_LABELS[note.category]}
        </span>
        {note.retracted ? (
          <span
            data-testid={`note-retracted-${id}`}
            className="rounded border border-red-800 px-1.5 text-xs font-semibold text-red-900"
          >
            Retracted
          </span>
        ) : null}
        <span className="text-slate-700">
          By {note.author}
          {note.author === note.createdBy ? '' : ` (written by ${note.createdBy})`}, version{' '}
          {note.version},{' '}
          <time dateTime={note.updatedPlantAt}>{formatPlantTime(note.updatedPlantAt)}</time> plant
          time
        </span>
      </p>
      <p
        data-testid={`note-text-${id}`}
        className={`mt-1 whitespace-pre-wrap break-words ${note.retracted ? 'text-slate-600 line-through' : ''}`}
      >
        {note.text}
      </p>
      {saved && !editing ? (
        <p role="status" data-testid={`note-saved-${id}`} className="mt-1 text-sm text-emerald-900">
          {saved}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2 print:hidden">
        {canWrite && !editing ? (
          <button
            ref={editButton}
            type="button"
            data-testid={`edit-note-${id}`}
            className={buttonClass}
            onClick={() => {
              setSaved(undefined);
              setEditing(true);
            }}
          >
            Edit
          </button>
        ) : null}
        <button
          type="button"
          data-testid={`note-history-toggle-${id}`}
          aria-expanded={history}
          className={buttonClass}
          onClick={() => {
            setHistory((open) => !open);
          }}
        >
          {history ? 'Hide history' : 'History'}
        </button>
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

/** The handover notes of the report's instance, with the editor (#146). */
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
    <section
      aria-labelledby="handover-title"
      data-testid="handover-notes"
      data-count={String(notes.length)}
      className="report-section"
    >
      <h2 id="handover-title" className="text-xl font-semibold">
        Handover notes
      </h2>
      <p className="text-sm text-slate-700 print:hidden">
        Notes can be written from the shift&apos;s start until the end of the following shift (plant
        time). A wrong note is retracted, never deleted; every version stays in its history.
      </p>
      {read.isError ? (
        <QueryError what="the notes" error={read.error} onRetry={() => void read.refetch()} />
      ) : null}
      <ol className="mt-2 flex flex-col gap-2" aria-label="Notes">
        {notes.map((note) => (
          <NoteItem key={note.id} note={note} shift={shift} onSaved={onSaved} />
        ))}
      </ol>
      {notes.length === 0 ? (
        <p className="mt-2 text-sm" data-testid="notes-empty">
          No handover note for this shift.
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-3 print:hidden">
        {canWrite ? (
          <NewNoteForm
            shift={shift}
            full={notes.length >= NOTE_LIMIT}
            onSaved={() => void onSaved()}
          />
        ) : (
          <p data-testid="notes-read-only" className="text-sm text-slate-800">
            Your role cannot write handover notes: they are shown read-only.
          </p>
        )}
      </div>
    </section>
  );
}
