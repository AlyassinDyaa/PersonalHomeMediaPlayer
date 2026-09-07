import React from 'react';

/**
 * The last thing between a broken render and a blank screen.
 *
 * React unmounts the whole tree when a render throws, which leaves a white
 * page and nothing else — no message, no clue, and on a tablet no console to
 * look in either. That failure is indistinguishable from the library being
 * down, the network being wrong, or the address being mistyped, so it sends
 * somebody chasing the wrong problem entirely.
 *
 * This catches the throw and says what happened instead. It is deliberately
 * plain: inline styles rather than the stylesheet, because a render that died
 * this early may have died before the stylesheet meant anything.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept for anyone who does have a console open; the screen is the report
    // that matters, but this is free and occasionally the faster read.
    console.error('The library could not be drawn:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <FailureScreen error={this.state.error} />;
  }
}

/**
 * What a failure looks like.
 *
 * Shared with the entry point, which has the same problem before React is
 * running at all and cannot use a component to say so.
 */
export function FailureScreen({ error }) {
  return (
    <div style={SCREEN}>
      <div style={CARD}>
        <h1 style={TITLE}>The library could not be opened</h1>
        <p style={TEXT}>
          Something went wrong while drawing this page. The library itself is
          probably fine — reloading often clears it.
        </p>
        <button type="button" style={BUTTON} onClick={() => window.location.reload()}>
          Reload
        </button>
        <p style={LABEL}>What went wrong</p>
        <pre style={DETAIL}>{detailOf(error)}</pre>
      </div>
    </div>
  );
}

/** The message and where it came from, as much as the browser will say. */
function detailOf(error) {
  if (!error) return 'No details were reported.';
  const message = error.message || String(error);
  return error.stack ? message + '\n\n' + error.stack : message;
}

const SCREEN = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '24px', background: '#0b0b0f', color: '#f4f4f6',
  font: '15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const CARD = { width: '100%', maxWidth: '560px' };
const TITLE = { margin: '0 0 10px', fontSize: '21px', fontWeight: 600 };
const TEXT = { margin: '0 0 18px', color: '#a0a0ac' };
const LABEL = { margin: '22px 0 6px', fontSize: '13px', color: '#71717f' };

const BUTTON = {
  padding: '13px 22px', fontSize: '16px', fontWeight: 600, border: 'none',
  borderRadius: '10px', background: '#7d8aa0', color: '#fff', cursor: 'pointer',
};

/*
 * The detail wraps rather than scrolls sideways.
 *
 * It exists to be read off a phone and repeated to somebody, and a stack trace
 * that runs off the right edge of a narrow screen cannot be.
 */
const DETAIL = {
  margin: 0, padding: '12px 14px', borderRadius: '10px', background: '#16161d',
  border: '1px solid #2a2a35', color: '#c9c9d4', fontSize: '12px',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '40vh', overflowY: 'auto',
};

export default ErrorBoundary;
