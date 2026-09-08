import { Contract, ZeroAddress, getAddress } from 'ethers';
import { ERC20 } from './abi.js';
import { CURVE, PONS_FACTORY, HOOK } from './pons-abi.js';
import { clean, type Config } from './config.js';
import type { Candidate } from './store.js';
import type { Market, Quote, RpcProvider } from './v3.js';
import { V4, type PoolKey } from './v4.js';

export interface PonsMarketState {
  readAt?: number;
  phase: number;
  quoteReserve: bigint;
  tokenReserve: bigint;
  realReserve: bigint;
  sellable: bigint;
  feeBps: bigint;
  taxBps: bigint;
  snipeBps: bigint;
  progressBps: number;
  ready: boolean;
  graduated: boolean;
  key: PoolKey;
}
const BPS = 10000n;
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

// Integer fee order matches PONS: buy fees before pricing; sell fees after pricing.
// The phantom reserve is part of quoteReserve. It is never spendable liquidity.
export function curveQuote(s: PonsMarketState, amount: bigint, sell = false): Quote {
  if (amount <= 0n || s.quoteReserve <= 0n || s.tokenReserve <= 0n)
    throw Error('Invalid PONS amount or reserves');
  if (s.phase !== 0 || s.graduated || s.ready || s.sellable === 0n)
    throw Error('PONS curve closed: waiting for its V4 pool');
  if (s.feeBps < 0n || s.taxBps < 0n || s.feeBps + s.taxBps > 2000n)
    throw Error('Unsupported PONS fee policy');
  let spent = amount,
    out: bigint,
    nextQuote: bigint,
    nextTokens: bigint;
  if (sell) {
    const gross = (amount * s.quoteReserve) / (s.tokenReserve + amount);
    if (gross > s.realReserve) throw Error('PONS sell exceeds real quote reserves');
    out = gross - (gross * s.feeBps) / BPS - (gross * s.taxBps) / BPS;
    nextQuote = s.quoteReserve - gross;
    nextTokens = s.tokenReserve + amount;
  } else {
    const cap = BPS - s.feeBps - s.taxBps - 100n;
    const snipe = s.snipeBps < cap ? s.snipeBps : cap;
    const net = (gross: bigint) =>
      gross - (gross * s.feeBps) / BPS - (gross * s.taxBps) / BPS - (gross * snipe) / BPS;
    out = (net(spent) * s.tokenReserve) / (s.quoteReserve + net(spent));
    if (out > s.sellable) {
      out = s.sellable;
      const needed = (out * s.quoteReserve) / (s.tokenReserve - out) + 1n;
      const grossed = ceilDiv(needed * BPS, BPS - s.feeBps - s.taxBps - snipe);
      spent = grossed < amount ? grossed : amount;
    }
    nextQuote = s.quoteReserve + net(spent);
    nextTokens = s.tokenReserve - out;
  }
  if (out <= 0n || nextTokens <= 0n) throw Error('PONS quote rounds to zero');
  const before = s.quoteReserve * nextTokens;
  const after = nextQuote * s.tokenReserve;
  const difference = after > before ? after - before : before - after;
  const priceMoveBps = Number(ceilDiv(difference * BPS, before));
  // PONS compares input/output RATE on clamped buys. Scale the minimum to
  // the full offered input, otherwise a predicted refund weakens protection.
  return {
    out,
    spent,
    minimumBasis: sell ? out : ceilDiv(out * amount, spent),
    priceMoveBps,
    at: s.readAt ?? Date.now(),
  };
}

export class Pons {
  readonly v4: V4;
  constructor(
    readonly c: Config,
    readonly provider: RpcProvider,
    readonly recipient = ZeroAddress,
  ) {
    this.v4 = new V4(c, provider);
  }
  async doctor() {
    const factory = new Contract(this.c.PONS_V2_FACTORY, PONS_FACTORY, this.provider);
    if ((await this.provider.getCode(this.c.PONS_V2_FACTORY)) === '0x')
      throw Error('PONS factory has no code');
    const [manager, hookAddress, permit2] = await Promise.all([
      factory.getFunction('poolManager')(),
      factory.getFunction('memeHook')(),
      factory.getFunction('permit2')(),
    ]);
    if (getAddress(manager) !== this.c.V4_POOL_MANAGER || getAddress(permit2) !== this.c.PERMIT2)
      throw Error('PONS factory / V4 deployment mismatch');
    if ((await this.provider.getCode(hookAddress)) === '0x') throw Error('PONS hook has no code');
    const hook = new Contract(hookAddress, HOOK, this.provider);
    if (
      getAddress(await hook.getFunction('factory')()) !== this.c.PONS_V2_FACTORY ||
      getAddress(await hook.getFunction('poolManager')()) !== this.c.V4_POOL_MANAGER
    )
      throw Error('PONS hook belongs to another deployment');
    await this.v4.doctor();
    return {
      factory: this.c.PONS_V2_FACTORY,
      hook: getAddress(hookAddress),
      curve: true,
      v4: true,
    };
  }
  async discover(from: number, to: number): Promise<Candidate[]> {
    const logs = await this.provider.getLogs({
      address: this.c.PONS_V2_FACTORY,
      topics: [PONS_FACTORY.getEvent('TokenLaunched')!.topicHash],
      fromBlock: from,
      toBlock: to,
    });
    const found: Candidate[] = [];
    for (const log of logs) {
      const e = PONS_FACTORY.parseLog(log);
      if (!e || getAddress(e.args.pairToken) !== ZeroAddress) continue;
      const block = await this.provider.getBlock(log.blockNumber);
      if (!block?.hash || block.hash !== log.blockHash) throw Error('Unanchored PONS launch event');
      found.push({
        venue: 'pons',
        pool: getAddress(e.args.curve),
        token: getAddress(e.args.token),
        fee: 0,
        block: log.blockNumber,
        blockHash: block.hash,
        createdAt: block.timestamp,
        status: 'waiting',
        reason: 'PONS native ETH launch',
        symbol: 'PONS',
        decimals: 18,
        nextTry: 0,
      });
    }
    return found;
  }
  async market(curveAddress: string): Promise<Market> {
    const readAt = Date.now();
    const curve = new Contract(curveAddress, CURVE, this.provider);
    const factory = new Contract(this.c.PONS_V2_FACTORY, PONS_FACTORY, this.provider);
    const block = await this.provider.getBlock('latest');
    if (!block) throw Error('Missing PONS block');
    const at = { blockTag: block.number };
    const [tokenAddress, parent, pair] = await Promise.all([
      curve.getFunction('token')(at),
      curve.getFunction('factory')(at),
      curve.getFunction('pairToken')(at),
    ]);
    if (getAddress(parent) !== this.c.PONS_V2_FACTORY || getAddress(pair) !== ZeroAddress)
      throw Error('Not a native ETH curve from the configured PONS factory');
    const token = getAddress(tokenAddress);
    const launch = await factory.getFunction('getLaunchedToken')(token, at);
    if (
      !launch.exists ||
      getAddress(launch.token) !== token ||
      getAddress(launch.curve) !== getAddress(curveAddress) ||
      getAddress(launch.pairToken) !== ZeroAddress
    )
      throw Error('PONS launch record / curve mismatch');
    const erc20 = new Contract(token, ERC20, this.provider);
    const [symbol, decimals, hook] = await Promise.all([
      erc20.getFunction('symbol')(at),
      erc20.getFunction('decimals')(at),
      factory.getFunction('memeHook')(at),
    ]);
    if (Number(decimals) > 36) throw Error('Unsupported token decimals');
    const phase = Number(launch.phase);
    if (phase === 1) throw Error('PONS graduation pending: retaining position until pool creation');
    if (phase === 3) throw Error('PONS launch rescued: automatic trading unavailable');
    if (phase !== 0 && phase !== 2) throw Error('Unknown PONS phase');
    const key: PoolKey = {
      currency0: ZeroAddress,
      currency1: token,
      fee: Number(launch.poolFee),
      tickSpacing: Number(launch.tickSpacing),
      hooks: getAddress(hook),
    };
    if (key.fee !== 0 || key.tickSpacing <= 0 || key.tickSpacing > 32767)
      throw Error('Unsupported PONS V4 pool parameters');
    const s: PonsMarketState = {
      readAt,
      phase,
      key,
      quoteReserve: 0n,
      tokenReserve: 0n,
      realReserve: 0n,
      sellable: 0n,
      feeBps: 0n,
      taxBps: BigInt(launch.creatorTaxBps),
      snipeBps: 0n,
      ready: phase === 2,
      graduated: phase === 2,
      progressBps: phase === 2 ? 10000 : 0,
    };
    const m: Market = {
      venue: 'pons',
      route: phase === 2 ? 'v4' : 'curve',
      pool: getAddress(curveAddress),
      token,
      symbol: clean(symbol, 12),
      decimals: Number(decimals),
      fee: 0,
      liquidity: 0n,
      wethBalance: 0n,
      sqrt: 0n,
      pons: s,
    };
    if (phase === 2) return this.v4.market(m, block.number);
    const [reserves, real, sellable, fee, tax, snipe, ready, graduated, policy] = await Promise.all(
      [
        curve.getFunction('getReserves')(at),
        curve.getFunction('realQuoteReserve')(at),
        curve.getFunction('sellableTokens')(at),
        curve.getFunction('feeBps')(at),
        curve.getFunction('creatorTaxBps')(at),
        curve.getFunction('currentSnipeTaxBps')(this.recipient, at),
        curve.getFunction('readyToGraduate')(at),
        curve.getFunction('graduated')(at),
        curve.getFunction('feePolicy')(at),
      ],
    );
    if (getAddress(policy) !== key.hooks || BigInt(tax) !== s.taxBps)
      throw Error('PONS curve economics do not match launch record');
    const threshold = BigInt(launch.graduationThreshold);
    if (threshold <= 0n) throw Error('Invalid graduation threshold');
    Object.assign(s, {
      quoteReserve: BigInt(reserves[0]),
      tokenReserve: BigInt(reserves[1]),
      realReserve: BigInt(real),
      sellable: BigInt(sellable),
      feeBps: BigInt(fee),
      taxBps: BigInt(tax),
      snipeBps: BigInt(snipe),
      ready,
      graduated,
      progressBps: Number((BigInt(real) * BPS) / threshold),
    });
    m.liquidity = s.sellable;
    m.wethBalance = s.realReserve;
    return m;
  }
  entryCheck(m: Market) {
    const s = m.pons!;
    if (m.route !== 'curve')
      throw Error('PONS discovery only enters curves; V4 is for managed exits');
    if (s.ready || s.graduated || s.phase !== 0) throw Error('PONS curve closed');
    if (s.feeBps + s.taxBps > BigInt(this.c.PONS_MAX_FEE_BPS))
      throw Error('PONS trading fees exceed limit');
    if (s.snipeBps > BigInt(this.c.PONS_MAX_SNIPE_TAX_BPS))
      throw Error('Waiting for PONS opening snipe tax to decay');
    if (s.progressBps >= this.c.PONS_MAX_PROGRESS_BPS)
      throw Error('PONS curve too close to graduation');
    if (s.realReserve < this.c.PONS_MIN_REAL_ETH || s.sellable <= 0n)
      throw Error('Waiting for real PONS ETH liquidity');
  }
  async quote(m: Market, amount: bigint, sell = false): Promise<Quote> {
    if (m.route === 'v4') return this.v4.quote(m, amount, sell);
    return curveQuote(m.pons!, amount, sell);
  }
  async swapRequest(m: Market, amount: bigint, minimum: bigint, account: string, sell = false) {
    if (m.route === 'v4') return this.v4.swapRequest(m, amount, minimum, account, sell);
    return {
      to: m.pool,
      data: CURVE.encodeFunctionData(sell ? 'sell' : 'buy', [amount, minimum, account]),
      value: sell ? 0n : amount,
    };
  }
}
