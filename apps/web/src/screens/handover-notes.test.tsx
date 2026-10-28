import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, problem, sessionOf } from '../test/fixtures.ts';
import { renderApp } from '../test/render-app.tsx';
import { auditEntry, note, shiftRecord } from '../test/shift-fixtures.ts';
import { shiftMes, shiftState, type Write } from '../test/shift-mes.ts';

vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

const PATH = '/shifts/2026-10-15/A';

afterEach(() => {
  vi.unstubAllGlobals();
});

const type = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } });
};

describe('handover note editor', () => {
  it("creates a note as the session's user and shows it as plain text", async () => {
    const state = shiftState();
    const text = '<img src=x onerror="alert(1)"> Coolant topped up\nsecond line';
    const write: Write = (method, path, body) => {
      const created = note(1, {
        text,
        category: 'material',
        author: 'ayse',
        createdBy: 'ayse',
      });
      state.notes = [created];
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/shifts/2026-10-15/A/notes');
      expect(body).toEqual({ text, category: 'material' });
      return json({
        note: created,
        shift: shiftRecord({ revision: { inputs: 0, content: 1, contentAtFinal: null } }),
      });
    };
    const server = shiftMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(PATH);
    const form = await screen.findByTestId('new-note');
    // No name to type: the MES records the session's user (#170).
    expect(screen.queryByTestId('note-author')).toBeNull();
    fireEvent.change(within(form).getByTestId('note-category'), { target: { value: 'material' } });
    type(within(form).getByTestId('note-text-input'), text);
    fireEvent.click(within(form).getByTestId('add-note'));
    const shown = await screen.findByTestId('note-text-1');
    // Text, never markup: no element was created from it.
    expect(shown.textContent).toBe(text);
    expect(shown.querySelector('img')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByTestId('note-1').dataset.category).toBe('material');
    expect(within(form).getByTestId('new-note-message').dataset.kind).toBe('saved');
    expect(within(form).getByTestId<HTMLTextAreaElement>('note-text-input').value).toBe('');
    const post = server.calls.find((call) => call.method === 'POST');
    expect(post?.path).toMatch(/\?epoch=\d+$/);
  });

  it('lays the forms out on Fields: labelled controls, the count and hint, the error at the field (UX-5b)', async () => {
    const state = shiftState({ notes: [note(1)] });
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    await renderApp(PATH);
    const form = await screen.findByRole('form', { name: 'New note' });
    expect(form).toBe(screen.getByTestId('new-note'));
    const category = within(form).getByRole('combobox', { name: 'Category' });
    expect(category).toBe(within(form).getByTestId('note-category'));
    const text = within(form).getByRole('textbox', { name: 'Note' });
    expect(text).toBe(within(form).getByTestId('note-text-input'));
    expect(text.getAttribute('name')).toBe('text');
    expect(text.getAttribute('maxlength')).toBe('4000');
    const described = (text.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Shown as plain text.', '0 of 4000 characters']);
    // An empty note: the field is marked and says why; the form's message announces it.
    fireEvent.click(within(form).getByTestId('add-note'));
    expect(text.getAttribute('aria-invalid')).toBe('true');
    expect(within(form).getByText('The note is empty.')).toBeTruthy();
    expect(within(form).getByTestId('new-note-message').getAttribute('role')).toBe('alert');

    // The editor: the same fields, the retraction a labelled checkbox with what it means.
    fireEvent.click(screen.getByRole('button', { name: 'Edit note 1' }));
    const editor = screen.getByRole('form', { name: 'Edit note 1' });
    const retracted = within(editor).getByRole('checkbox', { name: 'Retracted' });
    expect(retracted).toBe(within(editor).getByTestId('note-retracted'));
    expect(
      document.getElementById(retracted.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('untick to restore it');
    // History toggles name their note and say whether they are open.
    const toggle = screen.getByRole('button', { name: 'History of note 1' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Hide history of note 1' }).getAttribute('aria-expanded'),
    ).toBe('true');
    // Who and when, plant time without a label; never a typed author field (#170).
    expect(screen.getByTestId('note-1').textContent).toContain('By Ayşe · version 1 · ');
    expect(screen.getByTestId('note-1').textContent).not.toContain('plant time');
    expect(screen.queryByTestId('note-author')).toBeNull();
  });

  it('asks for the text before sending', async () => {
    const state = shiftState();
    const server = shiftMes(state);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(PATH);
    const form = await screen.findByTestId('new-note');
    type(within(form).getByTestId('note-text-input'), '   ');
    fireEvent.click(within(form).getByTestId('add-note'));
    expect(within(form).getByTestId('new-note-message').textContent).toContain(
      'Write the note first',
    );
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('edits a note with the version it started from and shows its history', async () => {
    const first = note(1);
    const state = shiftState({ notes: [first] });
    const write: Write = (method, path, body) => {
      expect(method).toBe('PUT');
      expect(path).toBe('/api/v1/shifts/2026-10-15/A/notes/1');
      expect(body).toEqual({
        text: 'Pump replaced',
        category: 'equipment',
        retracted: true,
        version: 1,
      });
      const edited = note(1, {
        version: 2,
        text: 'Pump replaced',
        retracted: true,
        author: 'ayse',
      });
      state.notes = [edited];
      // The edit came with a session; the note was created before #170 (typed name).
      state.history = { 1: [auditEntry(edited, { authenticated: true }), auditEntry(first)] };
      return json({
        note: edited,
        shift: shiftRecord({ revision: { inputs: 0, content: 2, contentAtFinal: null } }),
      });
    };
    vi.stubGlobal('fetch', shiftMes(state, write).fetch);
    await renderApp(PATH);
    fireEvent.click(await screen.findByTestId('edit-note-1'));
    const editor = screen.getByTestId('note-editor-1');
    expect(editor.dataset.version).toBe('1');
    expect(document.activeElement).toBe(within(editor).getByTestId('note-text-input'));
    type(within(editor).getByTestId('note-text-input'), 'Pump replaced');
    fireEvent.click(within(editor).getByTestId('note-retracted'));
    fireEvent.click(within(editor).getByTestId('save-note'));
    await waitFor(() => {
      expect(screen.getByTestId('note-1').dataset.version).toBe('2');
    });
    expect(screen.queryByTestId('note-editor-1')).toBeNull();
    expect(screen.getByTestId('note-saved-1').textContent).toContain('version 2');
    expect(screen.getByTestId('note-retracted-1').textContent).toBe('Retracted');
    fireEvent.click(screen.getByTestId('note-history-toggle-1'));
    const history = await screen.findByTestId('note-history-1');
    await waitFor(() => {
      expect(
        within(history)
          .getAllByTestId('note-history-entry')
          .map((entry) => [entry.dataset.version, entry.dataset.action]),
      ).toEqual([
        ['2', 'edited'],
        ['1', 'created'],
      ]);
    });
    const [edit, create] = within(history).getAllByTestId('note-history-entry');
    expect(edit?.textContent).toContain('edited by ayse at');
    expect(edit?.textContent).not.toContain('not authenticated');
    expect(create?.textContent).toContain('created by Ayşe (not authenticated)');
  });

  it('never sends a draft over a note that moved on (pushed), and reloads it', async () => {
    const state = shiftState({ notes: [note(1)] });
    const server = shiftMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(PATH);
    await app.open();
    fireEvent.click(await screen.findByTestId('edit-note-1'));
    const editor = screen.getByTestId('note-editor-1');
    type(within(editor).getByTestId('note-text-input'), 'My draft');
    await app.push({
      type: 'handover-note',
      event: 'edited',
      note: note(1, { version: 2, text: 'Their edit', author: 'Zeynep' }),
    });
    const stale = within(editor).getByTestId('note-stale');
    expect(stale.textContent).toContain('Zeynep saved version 2');
    expect(within(editor).getByTestId<HTMLButtonElement>('save-note').disabled).toBe(true);
    fireEvent.submit(editor);
    expect(server.calls.some((call) => call.method === 'PUT')).toBe(false);
    // The draft is kept until the user reloads.
    expect(within(editor).getByTestId<HTMLTextAreaElement>('note-text-input').value).toBe(
      'My draft',
    );
    fireEvent.click(within(editor).getByTestId('reload-note'));
    expect(within(editor).getByTestId<HTMLTextAreaElement>('note-text-input').value).toBe(
      'Their edit',
    );
    expect(screen.getByTestId('note-editor-1').dataset.version).toBe('2');
    expect(within(editor).queryByTestId('note-stale')).toBeNull();
  });

  it('on 409 keeps the draft, reads the notes again and offers a reload', async () => {
    const state = shiftState({ notes: [note(1)] });
    const write: Write = () => {
      // Someone else's edit landed first, and its push has not reached this tab.
      state.notes = [note(1, { version: 2, text: 'Their edit', author: 'Zeynep' })];
      return problem(
        409,
        'Conflict',
        'note 1 changed: version is 2, not 1',
        '/x',
        PROBLEM_TYPES.noteStale,
      );
    };
    const server = shiftMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(PATH);
    fireEvent.click(await screen.findByTestId('edit-note-1'));
    const editor = screen.getByTestId('note-editor-1');
    type(within(editor).getByTestId('note-text-input'), 'My draft');
    fireEvent.click(within(editor).getByTestId('save-note'));
    const message = await within(editor).findByTestId('note-message');
    expect(message.dataset.kind).toBe('stale');
    await waitFor(() => {
      expect(within(editor).getByTestId('note-stale')).toBeTruthy();
    });
    expect(screen.getByTestId('note-text-1').textContent).toBe('Their edit');
    expect(within(editor).getByTestId<HTMLTextAreaElement>('note-text-input').value).toBe(
      'My draft',
    );
    expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('explains a closed handover window and the note limit', async () => {
    const state = shiftState();
    let answer = problem(
      409,
      'Conflict',
      'handover closed: notes of 2026-10-15/A can be written until 2026-10-15T19:00:00.000Z (plant time)',
      '/x',
      PROBLEM_TYPES.handoverClosed,
    );
    vi.stubGlobal('fetch', shiftMes(state, () => answer).fetch);
    await renderApp(PATH);
    const form = await screen.findByTestId('new-note');
    type(within(form).getByTestId('note-text-input'), 'Late note');
    fireEvent.click(within(form).getByTestId('add-note'));
    const closed = await within(form).findByTestId('new-note-message');
    expect(closed.dataset.kind).toBe('closed');
    expect(closed.textContent).toContain('handover window is closed');
    expect(closed.getAttribute('role')).toBe('alert');

    answer = problem(
      422,
      'Unprocessable Entity',
      'at most 200 notes per shift',
      '/x',
      PROBLEM_TYPES.noteLimit,
    );
    fireEvent.click(within(form).getByTestId('add-note'));
    await waitFor(() => {
      expect(within(form).getByTestId('new-note-message').dataset.kind).toBe('limit');
    });
    expect(within(form).getByTestId('new-note-message').textContent).toContain('200 notes');
  });

  it('offers no new note once the shift holds the most notes', async () => {
    const notes = Array.from({ length: 200 }, (_, index) => note(index + 1));
    vi.stubGlobal('fetch', shiftMes(shiftState({ notes })).fetch);
    await renderApp(PATH);
    await waitFor(() => {
      expect(screen.getByTestId('handover-notes').dataset.count).toBe('200');
    });
    expect(screen.getByTestId('note-limit').textContent).toContain('200 notes');
    expect(screen.getByTestId<HTMLButtonElement>('add-note').disabled).toBe(true);
  });

  it('starts every draft afresh on another shift, also one read before (M1)', async () => {
    const state = shiftState({ notes: [note(1)] });
    const server = shiftMes(state);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(PATH);
    const shown = () => screen.getByTestId('shift-report').dataset.key;
    await screen.findByTestId('note-1');
    const pick = (key: string) => {
      fireEvent.change(screen.getByTestId('shift-select'), { target: { value: key } });
    };
    // Shift C of the day before is read once, so it is cached when the draft is switched to it.
    await screen.findByRole('option', { name: /shift C/ });
    pick('2026-10-14/C');
    await waitFor(() => {
      expect(shown()).toBe('2026-10-14/C');
    });
    pick('2026-10-15/A');
    await waitFor(() => {
      expect(shown()).toBe('2026-10-15/A');
    });
    type(
      within(screen.getByTestId('new-note')).getByTestId('note-text-input'),
      'About shift A only',
    );
    fireEvent.click(await screen.findByTestId('edit-note-1'));
    type(within(screen.getByTestId('note-editor-1')).getByTestId('note-text-input'), 'Edit of A');
    pick('2026-10-14/C');
    await waitFor(() => {
      expect(shown()).toBe('2026-10-14/C');
    });
    const form = screen.getByTestId('new-note');
    expect(within(form).getByTestId<HTMLTextAreaElement>('note-text-input').value).toBe('');
    expect(screen.queryByTestId('note-editor-1')).toBeNull();
    fireEvent.click(within(form).getByTestId('add-note'));
    expect(within(form).getByTestId('new-note-message').dataset.kind).toBe('invalid');
    expect(server.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('says when the notes cannot be read', async () => {
    const state = shiftState({
      notesAnswer: () => problem(503, 'Service Unavailable', 'shifts are not available', '/x'),
    });
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    await renderApp(PATH);
    const section = await screen.findByTestId('handover-notes');
    await waitFor(() => {
      expect(within(section).getByRole('alert').textContent).toContain('Could not load the notes');
    });
  });

  it.each([
    ['admin', ['admin'] as const, false],
    ['quality', ['quality'] as const, true],
  ])('lets a %s write notes only with note:write', async (_role, roles, writes) => {
    const state = shiftState({ notes: [note(1)] });
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    await renderApp(PATH, { session: sessionOf(roles) });
    await screen.findByTestId('note-1');
    // The notes and their history stay readable either way.
    expect(screen.getByTestId('note-history-toggle-1')).toBeTruthy();
    if (writes) {
      expect(screen.getByTestId('new-note')).toBeTruthy();
      expect(screen.getByTestId('edit-note-1')).toBeTruthy();
      expect(screen.queryByTestId('notes-read-only')).toBeNull();
    } else {
      expect(screen.queryByTestId('new-note')).toBeNull();
      expect(screen.queryByTestId('edit-note-1')).toBeNull();
      expect(screen.getByTestId('notes-read-only').textContent).toContain('cannot write');
      expect(screen.getByTestId('notes-read-only').className).toContain('bg-neutral-soft');
    }
  });
});
