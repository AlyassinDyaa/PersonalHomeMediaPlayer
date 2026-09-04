import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import ProfileFace from './ProfileFace.jsx';

/**
 * Asking for something to be added, and answering.
 *
 * Two screens in one, because they are two halves of the same thing: everyone
 * gets a box to ask with and a list of what they have asked for, and the owner
 * gets everybody's, since answering is their job alone.
 *
 * Answered requests stay on the list. Somebody who asked a fortnight ago should
 * be able to see it was read and what came of it — a row that quietly vanishes
 * looks exactly like one that was ignored.
 */

function when(at) {
  if (!at) return '';
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  return new Date(at).toLocaleDateString();
}

const STATUS_LABEL = { open: 'Waiting', done: 'Added', declined: 'Not this time' };

export function RequestsPanel({ isOwner }) {
  const [rows, setRows] = useState(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const body = await api.requests();
      setRows(body.requests ?? []);
    } catch (failure) {
      setError(failure.message);
      setRows([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const ask = useCallback(async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addRequest({ title, note });
      setTitle('');
      setNote('');
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [title, note, load]);

  const answer = useCallback(async (id, status) => {
    setBusy(true);
    try {
      await api.setRequestStatus(id, status);
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const withdraw = useCallback(async (id) => {
    setBusy(true);
    try {
      await api.deleteRequest(id);
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const waiting = (rows ?? []).filter((row) => row.status === 'open');
  const answered = (rows ?? []).filter((row) => row.status !== 'open');

  return (
    <>
      <section className="settings-card">
        <h2>Ask for something</h2>
        <p className="settings-hint">
          {isOwner
            ? 'What everybody has asked for, including you. Marking one answered '
              + 'leaves it on the list so whoever asked can see what came of it.'
            : 'Anything you would like added. The owner of the library sees these '
              + 'and can mark them once they are here.'}
        </p>

        {error && <div className="banner" style={{ margin: '0 0 14px' }}>{error}</div>}

        <form onSubmit={ask} className="request-form">
          <input
            className="key-input"
            placeholder="A film or a show — Spider-Verse, Batman Beyond"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            className="key-input"
            placeholder="Optional: anything worth knowing"
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
          />
          <button className="btn btn-primary" disabled={!title.trim() || busy}>
            {busy ? 'Sending…' : 'Ask'}
          </button>
        </form>
      </section>

      <section className="settings-card">
        <h2>{isOwner ? 'Waiting on you' : 'What you have asked for'}</h2>

        {rows === null && <p className="settings-hint">Loading…</p>}

        {rows !== null && waiting.length === 0 && (
          <p className="settings-empty">
            {isOwner ? 'Nothing is waiting.' : 'You have not asked for anything yet.'}
          </p>
        )}

        {waiting.map((row) => (
          <div key={row.id} className="request-row">
            {isOwner && <ProfileFace profile={row.profile} size="list" />}
            <div className="request-text">
              <strong>{row.title}</strong>
              {row.note && <span className="request-note">{row.note}</span>}
              <span className="request-meta">
                {isOwner ? row.profile.name + ' · ' : ''}{when(row.createdAt)}
              </span>
            </div>

            <div className="request-actions">
              {isOwner && (
                <>
                  <button className="btn btn-ghost" disabled={busy}
                          onClick={() => answer(row.id, 'done')}>
                    Added
                  </button>
                  <button className="btn btn-ghost" disabled={busy}
                          onClick={() => answer(row.id, 'declined')}>
                    Not this time
                  </button>
                </>
              )}
              <button className="btn btn-ghost danger-text" disabled={busy}
                      onClick={() => withdraw(row.id)}>
                {isOwner ? 'Clear' : 'Withdraw'}
              </button>
            </div>
          </div>
        ))}

        {answered.length > 0 && (
          <div className="health-group">
            <h3>Answered</h3>
            {answered.map((row) => (
              <div key={row.id} className="request-row answered">
                <div className="request-text">
                  <strong>{row.title}</strong>
                  <span className="request-meta">
                    {isOwner ? row.profile.name + ' · ' : ''}
                    {STATUS_LABEL[row.status]} · {when(row.resolvedAt ?? row.createdAt)}
                  </span>
                </div>
                {isOwner && (
                  <div className="request-actions">
                    <button className="btn btn-ghost" disabled={busy}
                            onClick={() => answer(row.id, 'open')}>
                      Reopen
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export default RequestsPanel;
