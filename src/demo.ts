import { parseEther } from 'ethers';
import { fresh, type State } from './store.js';
const symbols = ['HPEPE', 'RBONK', 'DUST', 'HOODAI', 'GCAT', 'HNY', 'DEGEN', 'ROBIN'];
export function demoState(seconds: number): State {
  const s = fresh('demo');
  const count = Math.min(8, Math.max(0, Math.floor(seconds / 2.3)));
  for (let i = 0; i < count; i++) {
    const token = '0x' + String(i + 1).padStart(40, '0'),
      pool = '0x' + String(i + 101).padStart(40, '0');
    const blocked = i === 2 || i === 5,
      age = seconds - i * 2.3,
      filled = age > 1.3 && !blocked;
    s.pools[pool] = {
      pool,
      token,
      fee: 10000,
      block: 110 + i,
      blockHash: 'demo',
      createdAt: 0,
      status: blocked ? 'blocked' : filled ? 'entered' : 'ready',
      reason: blocked ? 'Illustrative risk rejection' : 'Illustrative entry',
      symbol: symbols[i]!,
      decimals: 18,
      nextTry: 0,
    };
    s.events.push({
      at: Date.UTC(2026, 8, 7, 12, 0, i * 2),
      kind: blocked ? 'BLOCKED' : filled ? 'PAPER BUY' : 'DETECTED',
      message: `${symbols[i]} / ${blocked ? 'liquidity check failed' : 'V3 liquidity found'}`,
    });
    if (filled) {
      const value = Math.max(0.0005, 0.001 + age * 0.00011 + Math.sin(age) * 0.0002);
      s.positions[token] = {
        token,
        pool,
        symbol: symbols[i]!,
        fee: 10000,
        decimals: 18,
        amountWei: '1000000000000000000',
        entryWei: parseEther('.001').toString(),
        gasWei: '0',
        markWei: parseEther(value.toFixed(8)).toString(),
        markAt: Date.now(),
        openedAt: Date.now(),
        nextExitTry: 0,
      };
      if (age > 9) {
        const p = s.positions[token]!;
        p.closedAt = Date.now();
        p.exitWei = p.markWei;
        p.markWei = '0';
        s.realizedWei = (BigInt(s.realizedWei) + BigInt(p.exitWei) - BigInt(p.entryWei)).toString();
      }
      s.spentWei = (BigInt(s.spentWei) + parseEther('.001')).toString();
    }
  }
  return s;
}
