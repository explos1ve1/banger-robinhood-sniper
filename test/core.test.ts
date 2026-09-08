import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEther } from 'ethers';
import { loadConfig, minOut, safeError, clean } from '../src/config.js';
import { Store, fresh, type Position } from '../src/store.js';
import { exitReason } from '../src/engine.js';
import { terminal } from '../src/terminal.js';
import { demoState } from '../src/demo.js';

test('slippage preserves a nonzero integer minimum and rejects invalid bounds', () => {
  assert.equal(minOut(10000n, 100), 9900n);
  assert.throws(() => minOut(1n, 100));
  assert.throws(() => minOut(100n, 10000));
  assert.throws(() => minOut(0n, 1));
});
test('live requires deliberate opt-in; paper never retains a key', () => {
  assert.throws(() => loadConfig({ MODE: 'live' }));
  const c = loadConfig({ MODE: 'paper', PRIVATE_KEY: 'never-retain-this' });
  assert.equal(c.PRIVATE_KEY, '');
  assert.throws(() => loadConfig({ BUY_ETH: '-1' }));
  assert.throws(() => loadConfig({ BUY_ETH: '2', MAX_SESSION_SPEND_ETH: '1' }));
});
test('exit thresholds use exact integer basis and include incurred gas', () => {
  const c = loadConfig({});
  const p = { entryWei: parseEther('1').toString(), gasWei: '0', openedAt: Date.now() } as Position;
  assert.equal(exitReason(p, parseEther('1.3'), c), 'TAKE PROFIT');
  assert.equal(exitReason(p, parseEther('.85'), c), 'STOP LOSS');
  assert.equal(exitReason(p, parseEther('1.1'), c), null);
  assert.equal(exitReason({ ...p, openedAt: 0 }, parseEther('1.1'), c), 'TIME EXIT');
});
test('atomic state persists a pending transaction and refuses a changed identity', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'banger-store-'));
  const s = new Store(d, 'local-test');
  s.acquire();
  try {
    s.state.spentWei = '123';
    s.state.pending = {
      hash: '0xabc',
      raw: 'signed-fixture',
      nonce: 2,
      action: 'buy',
      token: 't',
      pool: 'p',
      amountWei: '12',
      minimumWei: '5',
      createdAt: 1,
    };
    s.save();
    assert.throws(() => new Store(d, 'other-wallet'));
    assert.throws(() => new Store(d, 'local-test').acquire());
  } finally {
    s.release();
  }
  const restored = new Store(d, 'local-test');
  assert.equal(restored.state.pending?.nonce, 2);
  assert.equal(restored.state.spentWei, '123');
  fs.rmSync(d, { recursive: true, force: true });
});
test('errors and token names cannot inject control characters or expose RPC payloads', () => {
  assert.equal(clean('\x1b[31mFAKE\nTOKEN'), '[31mFAKETOKEN');
  assert.equal(
    safeError({ code: 'CALL_EXCEPTION', message: 'secret rpc request' }),
    'CALL_EXCEPTION',
  );
});
test('offline demo and terminal are explicit about simulated data', () => {
  const s = demoState(15),
    c = loadConfig({});
  const view = terminal(s, c, 100, true, 116);
  assert.match(view, /OFFLINE DEMO/);
  assert.match(view, /No RPC, wallet or real trades/);
  assert.match(view, /POSITION BOOK/);
  assert.equal(fresh('x').pending, null);
});
