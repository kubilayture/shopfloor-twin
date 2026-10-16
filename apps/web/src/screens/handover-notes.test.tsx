import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, problem } from '../test/fixtures.ts';
import { renderApp } from '../test/render-app.tsx';
import { auditEntry, note, shiftRecord } from '../test/shift-fixtures.ts';
import { memoryStorage, shiftMes, shiftState, type Write } from '../test/shift-mes.ts';

vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

const PATH = '/shifts/2026-10-15/A';

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const type = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } });
};

describe('handover note editor', () => {
  it('creates a note with the remembered author and shows it as plain text', async () => {
    storage.setItem('shopfloor.codedBy', 'Mehmet');
    const state = shiftState();
    const text = '<img src=x onerror="alert(1)"> Coolant topped up\nsecond line';
    const write: Write = (method, path, body) => {
      const created = note(1, {
        text,
        category: 'material',
        author: 'Mehmet',
        createdBy: 'Mehmet',
      });
      state.notes = [created];
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/shifts/2026-10-15/A/notes');
      expect(body).toEqual({ author: 'Mehmet', text, category: 'material' });
      return json({ note: created, shift: shiftRecord({ revision: { inputs: 0, content: 1 } }) });
    };
    const server = shiftMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(PATH);
    const form = await screen.findByTestId('new-note');
    expect(screen.getByTestId<HTMLInputElement>('note-author').value).toBe('Mehmet');
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

  it('asks for the author before sending and remembers it after a write', async () => {
    const state = shiftState();
    const write: Write = () => {
      const created = note(1, { author: 'Zeynep' });
      state.notes = [created];
      return json({ note: created, shift: shiftRecord() });
    };
    const server = shiftMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(PATH);
    const form = await screen.findByTestId('new-note');
    type(within(form).getByTestId('note-text-input'), 'Hello');
    fireEvent.click(within(form).getByTestId('add-note'));
    expect(within(form).getByTestId('new-note-message').dataset.kind).toBe('invalid');
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
    type(screen.getByTestId('note-author'), 'Zeynep');
    fireEvent.click(within(form).getByTestId('add-note'));
    await screen.findByTestId('note-1');
    expect(storage.getItem('shopfloor.codedBy')).toBe('Zeynep');
  });

  it('edits a note with the version it started from and shows its history', async () => {
    storage.setItem('shopfloor.codedBy', 'Mehmet');
    const first = note(1);
    const state = shiftState({ notes: [first] });
    const write: Write = (method, path, body) => {
      expect(method).toBe('PUT');
      expect(path).toBe('/api/v1/shifts/2026-10-15/A/notes/1');
      expect(body).toEqual({
        author: 'Mehmet',
        text: 'Pump replaced',
        category: 'equipment',
        retracted: true,
        version: 1,
      });
      const edited = note(1, {
        version: 2,
        text: 'Pump replaced',
        retracted: true,
        author: 'Mehmet',
      });
      state.notes = [edited];
      state.history = { 1: [auditEntry(edited), auditEntry(first)] };
      return json({ note: edited, shift: shiftRecord({ revision: { inputs: 0, content: 2 } }) });
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
  });

  it('never sends a draft over a note that moved on (pushed), and reloads it', async () => {
    storage.setItem('shopfloor.codedBy', 'Mehmet');
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
    storage.setItem('shopfloor.codedBy', 'Mehmet');
    const state = shiftState({ notes: [note(1)] });
    const write: Write = () => {
      // Someone else's edit landed first, and its push has not reached this tab.
      state.notes = [note(1, { version: 2, text: 'Their edit', author: 'Zeynep' })];
      return problem(409, 'Conflict', 'note 1 changed: version is 2, not 1', '/x');
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
    storage.setItem('shopfloor.codedBy', 'Mehmet');
    const state = shiftState();
    let answer = problem(
      409,
      'Conflict',
      'handover closed: notes of 2026-10-15/A can be written until 2026-10-15T19:00:00.000Z (plant time)',
      '/x',
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

    answer = problem(422, 'Unprocessable Entity', 'at most 200 notes per shift', '/x');
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
});
