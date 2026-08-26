/**
 * Checks who is let in.
 *
 * Run against a throwaway settings folder, so the real passcode is never read
 * or written by a test.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'authtest-'));
process.env.MEDIA_CONFIG_DIR = sandbox;
process.env.MEDIA_DATA_DIR = path.join(sandbox, 'data');

const { config, saveSettings, passcodeMatches } = await import('../server/src/config.js');
const {
  issueToken, tokenValid, readCookie, isLocalRequest, requestAuthorised,
  loginBlockedFor, recordFailure, recordSuccess,
} = await import('../server/src/auth.js');

let passed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    console.log('[FAIL] ' + name + ' — ' + error.message);
    process.exitCode = 1;
  }
}

const request = (address, cookie) => ({
  socket: { remoteAddress: address },
  headers: cookie ? { cookie } : {},
});

// --- passcodes ------------------------------------------------------------

check('a passcode is never stored in the settings file', () => {
  saveSettings({ passcode: 'opensesame' });
  const written = fs.readFileSync(path.join(sandbox, 'config.local.json'), 'utf8');
  assert.ok(!written.includes('opensesame'), 'the passcode itself must not appear');
  assert.ok(written.includes('passcodeHash'), 'only a hash is kept');
});

check('the right passcode is recognised and a wrong one is not', () => {
  assert.strictEqual(passcodeMatches('opensesame'), true);
  assert.strictEqual(passcodeMatches('opensesamf'), false);
  assert.strictEqual(passcodeMatches(''), false);
  assert.strictEqual(passcodeMatches(null), false);
});

check('the same passcode hashes differently for different people', () => {
  const first = config.passcodeHash;
  saveSettings({ passcode: 'opensesame' });
  assert.notStrictEqual(config.passcodeHash, first, 'a fresh salt each time');
  assert.strictEqual(passcodeMatches('opensesame'), true);
});

check('a passcode that is too short is refused', () => {
  assert.throws(() => saveSettings({ passcode: '12' }), /four characters/);
});

check('clearing the passcode also stops sharing', () => {
  saveSettings({ passcode: 'opensesame' });
  saveSettings({ remoteAccess: true });
  assert.strictEqual(config.remoteAccess, true);

  saveSettings({ passcode: '' });
  assert.strictEqual(config.passcodeHash, null);
  assert.strictEqual(config.remoteAccess, false, 'an unguarded library is never left shared');
});

check('sharing cannot be switched on without a passcode', () => {
  assert.throws(() => saveSettings({ remoteAccess: true }), /Set a passcode/);
});

// --- tokens ---------------------------------------------------------------

check('a token this server issued is accepted', () => {
  assert.strictEqual(tokenValid(issueToken()), true);
});

check('an edited token is rejected', () => {
  const token = issueToken();
  const [body, signature] = token.split('.');
  // Push the expiry far into the future and keep the old signature.
  assert.strictEqual(tokenValid((Number(body) + 10_000_000) + '.' + signature), false);
});

check('nonsense is rejected rather than throwing', () => {
  for (const bad of ['', 'x', 'a.b', null, undefined, 'abc.def.ghi', '9'.repeat(50)]) {
    assert.strictEqual(tokenValid(bad), false, String(bad));
  }
});

check('an expired token is rejected', () => {
  // Signed by this server, but for a moment that has passed.
  const past = String(Date.now() - 1000);
  const token = issueToken();
  const forged = past + '.' + token.split('.')[1];
  assert.strictEqual(tokenValid(forged), false);
});

// --- cookies --------------------------------------------------------------

check('the session cookie is found among others', () => {
  const header = 'theme=dark; media_session=abc123; other=1';
  assert.strictEqual(readCookie({ headers: { cookie: header } }, 'media_session'), 'abc123');
  assert.strictEqual(readCookie({ headers: {} }, 'media_session'), null);
});

// --- who gets in ----------------------------------------------------------

check('this machine is always allowed in', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.strictEqual(isLocalRequest(request(address)), true, address);
    assert.strictEqual(requestAuthorised(request(address)), true, address);
  }
});

check('another machine is not, merely by asking', () => {
  assert.strictEqual(isLocalRequest(request('192.168.1.50')), false);
  assert.strictEqual(requestAuthorised(request('192.168.1.50')), false);
});

check('another machine is allowed in with a valid token, once sharing is on', () => {
  saveSettings({ passcode: 'opensesame' });
  saveSettings({ remoteAccess: true });
  const cookie = 'media_session=' + issueToken();
  assert.strictEqual(requestAuthorised(request('192.168.1.50', cookie)), true);
});

check('a valid token is worthless while sharing is off', () => {
  const cookie = 'media_session=' + issueToken();
  saveSettings({ remoteAccess: false });
  assert.strictEqual(requestAuthorised(request('192.168.1.50', cookie)), false);
});

check('a valid token is worthless once the passcode is cleared', () => {
  saveSettings({ passcode: 'opensesame' });
  saveSettings({ remoteAccess: true });
  const cookie = 'media_session=' + issueToken();
  assert.strictEqual(requestAuthorised(request('192.168.1.50', cookie)), true);

  saveSettings({ passcode: '' });
  assert.strictEqual(requestAuthorised(request('192.168.1.50', cookie)), false);
});

// --- guessing -------------------------------------------------------------

check('repeated wrong guesses are locked out', () => {
  const address = '192.168.1.77';
  assert.strictEqual(loginBlockedFor(address), 0);
  for (let i = 0; i < 8; i++) recordFailure(address);
  assert.ok(loginBlockedFor(address) > 0, 'blocked after eight tries');

  recordSuccess(address);
  assert.strictEqual(loginBlockedFor(address), 0, 'a success clears it');
});

check('one address being locked out does not affect another', () => {
  const victim = '192.168.1.88';
  for (let i = 0; i < 8; i++) recordFailure(victim);
  assert.ok(loginBlockedFor(victim) > 0);
  assert.strictEqual(loginBlockedFor('192.168.1.99'), 0);
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('\npassed ' + passed + ' of ' + total);
