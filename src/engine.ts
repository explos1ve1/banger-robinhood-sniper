import { Contract, Wallet, formatEther, type JsonRpcProvider } from 'ethers';
import fs from 'node:fs';
import { ERC20 } from './abi.js';
import { minOut, safeError, type Config } from './config.js';
import { Store, identity, stateDirectory, type Candidate, type Position } from './store.js';
import { Transactions } from './transactions.js';
import { V3, makeProvider, type Market, type RpcProvider } from './v3.js';

export function openPositions(store: Store) {
  return Object.values(store.state.positions).filter((p) => !p.closedAt);
}
export function unrealized(store: Store) {
  return openPositions(store).reduce(
    (sum, p) => sum + BigInt(p.markWei) - BigInt(p.entryWei) - BigInt(p.gasWei),
    0n,
  );
}
export function exitReason(
  p: Position,
  quoted: bigint,
  c: Config,
  now = Date.now(),
): string | null {
  const basis = BigInt(p.entryWei) + BigInt(p.gasWei),
    gain = quoted - basis;
  if (gain * 10000n >= basis * BigInt(c.TAKE_PROFIT_BPS)) return 'TAKE PROFIT';
  if (gain * 10000n <= -basis * BigInt(c.STOP_LOSS_BPS)) return 'STOP LOSS';
  if (now - p.openedAt >= c.MAX_HOLD_SECONDS * 1000) return 'TIME EXIT';
  return null;
}
export class Engine {
  readonly provider: RpcProvider;
  readonly dex: V3;
  readonly account: string;
  readonly store: Store;
  readonly tx?: Transactions;
  block = 0;
  connected = false;
  stopping = false;
  constructor(
    readonly c: Config,
    provider?: RpcProvider,
  ) {
    this.provider = provider ?? makeProvider(c);
    this.dex = new V3(c, this.provider);
    this.account = c.MODE === 'live' ? new Wallet(c.PRIVATE_KEY).address : 'no-signer';
    this.store = new Store(stateDirectory(c, this.account), identity(c, this.account));
    this.store.acquire();
    if (c.MODE === 'live')
      this.tx = new Transactions(
        c,
        this.provider,
        this.store,
        (action) => !this.stopping && (action !== 'buy' || this.canEnter()),
      );
  }
  async init() {
    const report = await this.dex.doctor();
    this.block = report.block;
    this.connected = true;
    this.store.event(
      'ONLINE',
      `Chain ${report.chainId} / ${report.routerKind} / ${this.c.MODE.toUpperCase()}`,
    );
    return report;
  }
  async scan() {
    const s = this.store.state;
    const head = await this.provider.getBlockNumber();
    this.block = head;
    const safe = head - this.c.CONFIRMATIONS + 1;
    if (safe < 0) return;
    if (s.cursor < 0) s.cursor = Math.max(0, safe - this.c.LOOKBACK_BLOCKS) - 1;
    if (s.cursor >= 0 && s.cursorHash) {
      const b = await this.provider.getBlock(s.cursor);
      if (!b || b.hash !== s.cursorHash) {
        s.cursor = Math.max(-1, s.cursor - 32);
        s.cursorHash = '';
        // Existing executed positions are never rolled back as an invented refund.
        fs.writeFileSync(
          this.store.pauseFile,
          'Discovery reorg. Review receipts before resuming entries.\n',
        );
        this.store.event(
          'REORG',
          'Cursor rewound 32 blocks; new entries paused; position management continues',
        );
      }
    }
    let span = this.c.LOG_CHUNK_BLOCKS;
    for (let chunk = 0; chunk < 5 && s.cursor < safe; chunk++) {
      const from = s.cursor + 1,
        to = Math.min(safe, from + span - 1);
      let found: Candidate[];
      try {
        found = await this.dex.discover(from, to);
      } catch (e) {
        if (span > 1) {
          span = Math.max(1, Math.floor(span / 2));
          chunk--;
          continue;
        }
        throw e;
      }
      for (const candidate of found) {
        if (!s.pools[candidate.pool]) {
          s.pools[candidate.pool] = candidate;
          this.store.event('DETECTED', `${candidate.token.slice(0, 12)} / V3 fee ${candidate.fee}`);
        }
      }
      const b = await this.provider.getBlock(to);
      if (!b?.hash) throw Error('Cannot anchor log cursor');
      s.cursor = to;
      s.cursorHash = b.hash;
      this.store.save();
    }
    // Bound historical discovery storage without discarding any active candidate or position.
    const old = Object.values(s.pools)
      .filter((p) => ['expired', 'blocked'].includes(p.status))
      .sort((a, b) => b.block - a.block)
      .slice(2000);
    for (const p of old) delete s.pools[p.pool];
  }
  async tick() {
    if (this.tx && !(await this.tx.reconcile())) return;
    await this.managePositions();
    if (this.store.state.pending) return;
    await this.scan();
    const queue = Object.values(this.store.state.pools)
      .filter((p) => p.status === 'waiting' || p.status === 'ready')
      .sort((a, b) => b.block - a.block)
      .slice(0, 20);
    for (const c of queue) {
      if (this.store.state.pending) break;
      if (Date.now() < c.nextTry) continue;
      if (Date.now() / 1000 - c.createdAt > this.c.MAX_POOL_AGE_SECONDS) {
        c.status = 'expired';
        c.reason = 'Entry age limit exceeded';
        this.store.save();
        continue;
      }
      if (this.block - c.block + 1 < this.c.MIN_POOL_AGE_BLOCKS) continue;
      try {
        const b = await this.provider.getBlock(c.block);
        if (!b || b.hash !== c.blockHash) {
          c.status = 'blocked';
          c.reason = 'Creation block was reorganized';
          this.store.save();
          continue;
        }
        const m = await this.dex.market(c.pool);
        c.symbol = m.symbol;
        c.decimals = m.decimals;
        if (m.token !== c.token || m.fee !== c.fee)
          throw Error('Pool event does not match contract');
        if (m.liquidity === 0n || m.wethBalance < this.c.MIN_POOL_WETH_ETH)
          throw Error('Waiting for active liquidity and minimum WETH balance');
        const q = await this.dex.quote(m, this.c.BUY_ETH);
        if (q.priceMoveBps > this.c.MAX_PRICE_MOVE_BPS)
          throw Error('Quoted price move exceeds limit');
        minOut(q.out, this.c.SLIPPAGE_BPS);
        const reverse = await this.dex.quote(m, q.out, true);
        if (reverse.out <= 0n) throw Error('Reverse quote unavailable');
        // Reverse quoting verifies pool math, not the token's ability to transfer or sell.
        if (c.status !== 'ready') {
          c.status = 'ready';
          c.reason = 'Liquidity + quote checks passed';
          this.store.event('READY', `${c.symbol} / ${formatEther(m.wethBalance)} WETH in pool`);
        }
        if (this.c.MODE !== 'watch' && this.canEnter()) await this.buy(c, m);
        c.nextTry = Math.max(c.nextTry, Date.now() + 5000);
        this.store.save();
      } catch (e) {
        c.reason = safeError(e);
        c.nextTry = Date.now() + 5000;
        this.store.save();
      }
    }
    this.connected = true;
  }
  canEnter(): boolean {
    const s = this.store.state;
    const open = openPositions(this.store);
    if (this.stopping || this.store.paused || s.pending || open.length >= this.c.MAX_OPEN_POSITIONS)
      return false;
    if (BigInt(s.spentWei) + this.c.BUY_ETH > this.c.MAX_SESSION_SPEND_ETH) return false;
    if (open.some((p) => !p.markAt || Date.now() - p.markAt > 30000)) return false;
    if (BigInt(s.realizedWei) + unrealized(this.store) <= -this.c.MAX_SESSION_LOSS_ETH)
      return false;
    if (this.c.MODE === 'paper') {
      const cash =
        this.c.PAPER_START_ETH +
        BigInt(s.realizedWei) -
        open.reduce((a, p) => a + BigInt(p.entryWei), 0n);
      if (cash < this.c.BUY_ETH) return false;
    }
    return true;
  }
  async buy(candidate: Candidate, m: Market) {
    if (!this.canEnter()) return;
    if (this.store.state.positions[m.token]) {
      candidate.status = 'blocked';
      candidate.reason = 'Token already handled in this session';
      this.store.save();
      return;
    }
    const fresh = await this.dex.market(m.pool);
    const q = await this.dex.quote(fresh, this.c.BUY_ETH);
    if (q.priceMoveBps > this.c.MAX_PRICE_MOVE_BPS) throw Error('Price moved before entry');
    const minimum = minOut(q.out, this.c.SLIPPAGE_BPS);
    if (this.c.MODE === 'paper') {
      const s = this.store.state;
      s.spentWei = (BigInt(s.spentWei) + this.c.BUY_ETH).toString();
      s.positions[m.token] = {
        pool: m.pool,
        token: m.token,
        symbol: m.symbol,
        decimals: m.decimals,
        fee: m.fee,
        amountWei: q.out.toString(),
        entryWei: this.c.BUY_ETH.toString(),
        gasWei: '0',
        openedAt: Date.now(),
        markWei: this.c.BUY_ETH.toString(),
        markAt: 0,
        nextExitTry: 0,
      };
      candidate.status = 'entered';
      candidate.reason = 'Paper quote fill / gas excluded';
      this.store.event('PAPER BUY', `${m.symbol} / ${formatEther(this.c.BUY_ETH)} ETH`);
      return;
    }
    if (!this.tx) throw Error('Watch mode cannot buy');
    const req = await this.dex.swapRequest(m, this.c.BUY_ETH, minimum, this.account);
    if (Date.now() - q.at > 5000) throw Error('Entry quote expired');
    await this.tx.execute(req, {
      action: 'buy',
      token: m.token,
      pool: m.pool,
      amountWei: this.c.BUY_ETH.toString(),
      minimumWei: minimum.toString(),
    });
  }
  async managePositions() {
    for (const p of openPositions(this.store)) {
      if (this.stopping) return;
      if (this.store.state.pending) return;
      try {
        const m = await this.dex.market(p.pool),
          q = await this.dex.quote(m, BigInt(p.amountWei), true);
        p.markWei = q.out.toString();
        p.markAt = Date.now();
        this.store.save();
        const reason = exitReason(p, q.out, this.c);
        if (reason && Date.now() >= p.nextExitTry) await this.sell(p, m, reason);
      } catch (e) {
        p.nextExitTry = Date.now() + 15000;
        this.store.event('EXIT RETRY', `${p.symbol}: ${safeError(e)}. Position retained.`);
      }
    }
  }
  async sell(p: Position, m: Market, reason: string) {
    if (this.c.MODE === 'paper') {
      const q = await this.dex.quote(m, BigInt(p.amountWei), true);
      p.exitWei = q.out.toString();
      p.closedAt = Date.now();
      p.markWei = '0';
      this.store.state.realizedWei = (
        BigInt(this.store.state.realizedWei) +
        q.out -
        BigInt(p.entryWei)
      ).toString();
      this.store.event('PAPER EXIT', `${p.symbol} / ${reason} / gas excluded`);
      return;
    }
    if (!this.tx) throw Error('No live signer');
    const token = new Contract(p.token, ERC20, this.provider);
    const amount = BigInt(p.amountWei);
    if ((await token.getFunction('balanceOf')(this.account)) < amount)
      throw Error('Tracked balance changed; refusing to sell an invented amount');
    const allowance: bigint = await token.getFunction('allowance')(this.account, this.c.V3_ROUTER);
    if (allowance < amount) {
      const approveAmount = allowance > 0n ? 0n : amount;
      await this.tx.execute(
        {
          to: p.token,
          data: ERC20.encodeFunctionData('approve', [this.c.V3_ROUTER, approveAmount]),
        },
        {
          action: 'approve',
          token: p.token,
          pool: p.pool,
          amountWei: approveAmount.toString(),
          minimumWei: '0',
        },
      );
      // A later tick obtains a fresh quote after allowance confirmation.
      return;
    }
    const fresh = await this.dex.market(p.pool),
      q = await this.dex.quote(fresh, amount, true),
      minimum = minOut(q.out, this.c.SLIPPAGE_BPS);
    const req = await this.dex.swapRequest(m, amount, minimum, this.account, true);
    if (Date.now() - q.at > 5000) throw Error('Exit quote expired');
    this.store.event('EXIT SENT', `${p.symbol} / ${reason}`);
    await this.tx.execute(req, {
      action: 'sell',
      token: p.token,
      pool: p.pool,
      amountWei: amount.toString(),
      minimumWei: minimum.toString(),
    });
  }
  close() {
    this.store.release();
    this.provider.destroy();
  }
}
