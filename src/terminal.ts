import { Chalk } from 'chalk';
import { formatEther } from 'ethers';
import { clean, type Config } from './config.js';
import type { State } from './store.js';
const colors = new Chalk({ level: process.stdout.isTTY || process.env.FORCE_COLOR ? 3 : 0 });
const lime = (s: string) => colors.hex('#c7ff42')(s),
  mint = (s: string) => colors.hex('#4cffa8')(s),
  muted = (s: string) => colors.hex('#90a49a')(s),
  red = (s: string) => colors.hex('#ff7865')(s);
export const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - strip(s).length));
const eth = (v: string | bigint) => Number(formatEther(v)).toFixed(6);
const pnl = (n: bigint) => `${n >= 0n ? '+' : ''}${eth(n)} ETH`;
function box(title: string, rows: string[], width: number) {
  return [
    muted('╭─ ') +
      lime(title) +
      muted(' ' + '─'.repeat(Math.max(0, width - title.length - 5)) + '╮'),
    ...rows.map((s) => {
      const text = strip(s).length > width - 4 ? strip(s).slice(0, width - 5) + '…' : s;
      return muted('│ ') + pad(text, width - 4) + muted(' │');
    }),
    muted('╰' + '─'.repeat(width - 2) + '╯'),
  ];
}
export function terminal(
  s: State,
  c: Pick<Config, 'MODE' | 'CHAIN_ID' | 'BUY_ETH' | 'MAX_SESSION_SPEND_ETH' | 'MAX_OPEN_POSITIONS'>,
  block = 0,
  demo = false,
  width = 116,
  paused = false,
): string {
  width = Math.min(132, Math.max(78, width));
  const open = Object.values(s.positions).filter((p) => !p.closedAt),
    closed = Object.values(s.positions).filter((p) => p.closedAt);
  const u = open.reduce(
      (sum, p) => sum + BigInt(p.markWei) - BigInt(p.entryWei) - BigInt(p.gasWei),
      0n,
    ),
    real = BigInt(s.realizedWei);
  const stat = (label: string, value: string) => muted(label.padEnd(16)) + value;
  const header = [
    lime('  ϟ  B A N G E R') + colors.bold('  /  SNIPER TERMINAL'),
    muted('     FIND IT. LOCK IT. BANG.') +
      ' '.repeat(8) +
      lime(demo ? 'OFFLINE DEMO' : c.MODE.toUpperCase() + (paused ? ' / PAUSED' : '')) +
      muted(`  ·  CHAIN ${c.CHAIN_ID}`),
    '',
  ];
  const split = width >= 108;
  const pools = Object.values(s.pools)
    .sort((a, b) => b.block - a.block)
    .slice(0, 7);
  const left = box(
    'TARGET FEED',
    [
      muted('TOKEN          POOL            STATE'),
      ...pools.map(
        (p) =>
          pad(colors.bold(clean(p.symbol, 12)), 15) +
          pad(p.pool.slice(0, 6) + '…' + p.pool.slice(-4), 16) +
          (p.status === 'entered'
            ? mint('FILLED')
            : p.status === 'blocked' || p.status === 'expired'
              ? red(p.status.toUpperCase())
              : lime(p.status.toUpperCase())),
      ),
      ...Array.from({ length: Math.max(0, 7 - pools.length) }, () =>
        muted('···            listening for new V3 pools'),
      ),
    ],
    split ? Math.floor((width - 2) * 0.57) : width,
  );
  const right = box(
    'SESSION CONTROL',
    [
      stat('ENTRY SIZE', eth(c.BUY_ETH) + ' ETH'),
      stat('OPEN / LIMIT', `${open.length} / ${c.MAX_OPEN_POSITIONS}`),
      stat('CLOSED', String(closed.length)),
      stat('GROSS SPENT', eth(s.spentWei) + ' ETH'),
      stat('BUDGET', eth(c.MAX_SESSION_SPEND_ETH) + ' ETH'),
      stat('BLOCK', String(block)),
      stat('TX STATUS', s.pending ? red('PENDING') : mint('CLEAR')),
      stat('GAS PAID', eth(s.gasWei) + ' ETH'),
    ],
    split ? width - 2 - strip(left[0]!).length : width,
  );
  const both = split
    ? Array.from(
        { length: Math.max(left.length, right.length) },
        (_, i) => pad(left[i] ?? '', strip(left[0]!).length) + '  ' + (right[i] ?? ''),
      )
    : [...left, '', ...right];
  const total = real + u;
  const colored = total >= 0n ? mint(pnl(total)) : red(pnl(total));
  const perf = box(
    'PERFORMANCE / ETH',
    [
      colors.bold('TOTAL PNL  ') + colored + '     ' + muted('realized ') + pnl(real),
      muted('OPEN MARK  ') +
        pnl(u) +
        muted(
          demo
            ? '  ·  illustrative data'
            : c.MODE === 'paper'
              ? '  ·  quoted paper fills; gas excluded'
              : '  ·  executable quotes; exit gas not yet incurred',
        ),
    ],
    width,
  );
  const col = width < 100 ? 16 : 20;
  const book = box(
    'POSITION BOOK',
    [
      muted(
        pad('TOKEN', 15) +
          pad('ENTRY / ETH', col) +
          pad('VALUE / ETH', col) +
          pad('PNL / ETH', col) +
          'STATE',
      ),
      ...Object.values(s.positions)
        .slice(-6)
        .map((p) => {
          const value = p.closedAt ? BigInt(p.exitWei ?? '0') : BigInt(p.markWei),
            profit = value - BigInt(p.entryWei) - BigInt(p.gasWei);
          return (
            pad(clean(p.symbol, 12), 15) +
            pad(eth(p.entryWei), col) +
            pad(eth(value), col) +
            pad(profit >= 0n ? mint(eth(profit)) : red(eth(profit)), col) +
            (p.closedAt ? 'CLOSED' : 'OPEN')
          );
        }),
      ...(Object.keys(s.positions).length
        ? []
        : [muted('No positions. Waiting for a qualifying entry.')]),
    ],
    width,
  );
  const tape = box(
    'EXECUTION TAPE',
    s.events
      .slice(-5)
      .reverse()
      .map(
        (e) =>
          muted(new Date(e.at).toISOString().slice(11, 19)) +
          '  ' +
          pad(lime(e.kind), 13) +
          clean(e.message, width - 31),
      ),
    width,
  );
  return [
    ...header,
    ...perf,
    '',
    ...both,
    '',
    ...book,
    '',
    ...tape,
    '',
    muted(
      demo
        ? '  DEMO · No RPC, wallet or real trades.'
        : '  p pause entries · r resume · q quit · Ctrl+C stop (positions are not automatically sold)',
    ),
    s.halt ? red('  ' + clean(s.halt, width - 3)) : '',
  ].join('\n');
}
