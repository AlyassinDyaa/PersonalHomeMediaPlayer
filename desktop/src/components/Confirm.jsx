import React, { useEffect, useRef, useState } from 'react';
import Overlay from './Overlay.jsx';

/**
 * Ask before doing something that cannot be undone.
 *
 * Replaces the browser's own confirm and prompt boxes, which were wrong here
 * for three reasons: they look like the browser rather than like this library,
 * they cannot be styled to say which button is the dangerous one, and on a
 * phone running this from its Home Screen they are unreliable — the same
 * machinery that refuses to raise a keyboard for the passcode field also
 * decides, sometimes, not to show a prompt at all. An action nobody can confirm
 * is an action nobody can take.
 *
 * The same component asks for a word as well as an answer, which is what a
 * rename is: a question with a text field attached.
 */
export function Confirm({
  title,
  body = null,
  confirmLabel = 'Remove',
  cancelLabel = 'Cancel',
  /** Red confirm button. True for anything that destroys something. */
  danger = true,
  /** `{ label, value, placeholder }` turns this into a rename. */
  field = null,
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState(field?.value ?? '');
  const input = useRef(null);

  /*
   * The field takes the keyboard on the next frame rather than during the
   * render, which is the only way iOS will raise it.
   */
  useEffect(() => {
    if (!field) return undefined;
    const timer = setTimeout(() => { input.current?.focus(); input.current?.select(); }, 60);
    return () => clearTimeout(timer);
  }, [field]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const nothingTyped = Boolean(field) && !value.trim();
  const confirm = () => {
    if (nothingTyped) return;
    onConfirm(field ? value.trim() : undefined);
  };

  return (
    <Overlay>
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="confirm-title">{title}</h3>
        {body && <p className="confirm-body">{body}</p>}

        {field && (
          <label className="confirm-field">
            {field.label}
            <input
              ref={input}
              className="key-input"
              value={value}
              placeholder={field.placeholder ?? ''}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') confirm(); }}
              spellCheck={false}
            />
          </label>
        )}

        <div className="confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={nothingTyped}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
    </Overlay>
  );
}

export default Confirm;
