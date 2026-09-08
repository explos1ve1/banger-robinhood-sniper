import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, AbiCoder } from 'ethers';
import { curveQuote, type PonsMarketState } from '../src/pons.js';
import { loadConfig, minOut } from '../src/config.js';
import { V4 } from '../src/v4.js';
import { UNIVERSAL, POOL_KEY } from '../src/pons-abi.js';
import type { Market, RpcProvider } from '../src/v3.js';

const state = (): PonsMarketState => ({
  phase: 0,
  quoteReserve: 10000n,
  tokenReserve: 20000n,
  realReserve: 8000n,
  sellable: 19000n,
  feeBps: 100n,
  taxBps: 200n,
  snipeBps: 0n,
  progressBps: 2000,
  ready: false,
  graduated: false,
  key: {
    currency0: ZeroAddress,
    currency1: '0x0000000000000000000000000000000000000003',
    fee: 0,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000002044',
  },
});

test('PONS fee rounding, partial-fill rate bounds, and closed/virtual-reserve refusal', () => {
  const s = state();
  assert.equal(curveQuote(s, 100n).out, 192n);
  assert.equal(curveQuote(s, 100n, true).out, 49n);
  const taxed = curveQuote({ ...s, snipeBps: 9900n }, 100n);
  assert.equal(taxed.out, 1n, 'opening tax is capped to leave 1% input net of fees');
  const partial = curveQuote({ ...s, sellable: 1n }, 100n);
  assert.equal(partial.spent, 2n);
  assert.equal(partial.out, 1n);
  assert.equal(partial.minimumBasis, 50n, 'rate minimum scales to the offered input');
  const minimum = minOut(partial.minimumBasis!, 100);
  assert.ok(partial.spent! * minimum <= 100n * partial.out);
  assert.throws(() => curveQuote({ ...s, ready: true }, 1n, true), /closed/);
  assert.throws(() => curveQuote({ ...s, phase: 1 }, 1n), /closed/);
  assert.throws(() => curveQuote({ ...s, realReserve: 1n }, 100n, true), /real quote reserves/);
  assert.throws(
    () => loadConfig({ PONS_MAX_PROGRESS_BPS: '9800', PONS_EXIT_PROGRESS_BPS: '9500' }),
    /must exceed/,
  );
});

test('V4 modern calldata preserves amount, recipient, hook key, deadline and native settlement', async () => {
  const c = loadConfig({});
  const provider = { getBlock: async () => ({ timestamp: 1000 }) } as unknown as RpcProvider;
  const m: Market = {
    venue: 'pons',
    route: 'v4',
    pons: { ...state(), phase: 2 },
    token: state().key.currency1,
    pool: '0x0000000000000000000000000000000000000004',
    symbol: 'TEST',
    decimals: 18,
    fee: 0,
    liquidity: 1n,
    wethBalance: 1n,
    sqrt: 1n << 96n,
  };
  const account = '0x0000000000000000000000000000000000000005';
  const request = await new V4(c, provider).swapRequest(m, 100n, 90n, account, true);
  const [commands, inputs, deadline] = UNIVERSAL.decodeFunctionData('execute', request.data);
  assert.equal(commands, '0x100b0c');
  assert.equal(deadline, 1060n);
  assert.equal(request.value, 0n);
  const coder = AbiCoder.defaultAbiCoder();
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  assert.equal(actions, '0x060c0e');
  const [swap] = coder.decode([`(${POOL_KEY},bool,uint128,uint128,uint256,bytes)`], params[0]);
  assert.equal(swap[0][4], state().key.hooks);
  assert.equal(swap[1], false);
  assert.equal(swap[2], 100n);
  assert.equal(swap[3], 90n);
  const [recipient, minimum] = coder.decode(['address', 'uint256'], inputs[2]);
  assert.equal(recipient, account);
  assert.equal(minimum, 90n);
});
