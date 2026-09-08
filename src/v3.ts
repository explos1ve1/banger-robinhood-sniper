import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  getAddress,
  type BrowserProvider,
  type TransactionRequest,
} from 'ethers';
import { CLASSIC, ROUTER02, QUOTER, POOL, FACTORY, ERC20 } from './abi.js';
import { clean, type Config } from './config.js';
import type { Candidate } from './store.js';

export interface Market {
  token: string;
  pool: string;
  fee: number;
  symbol: string;
  decimals: number;
  liquidity: bigint;
  wethBalance: bigint;
  sqrt: bigint;
}
export interface Quote {
  out: bigint;
  priceMoveBps: number;
  at: number;
}
export type RpcProvider = JsonRpcProvider | BrowserProvider;
export function makeProvider(c: Config) {
  const req = new FetchRequest(c.RPC_URL);
  req.timeout = c.RPC_TIMEOUT_MS;
  return new JsonRpcProvider(req, undefined, {
    cacheTimeout: 0,
    batchMaxCount: 1,
    pollingInterval: 500,
  });
}
export class V3 {
  kind: 'classic' | 'router02' = 'classic';
  constructor(
    readonly c: Config,
    readonly provider: RpcProvider,
  ) {}
  get iface() {
    return this.kind === 'classic' ? CLASSIC : ROUTER02;
  }
  async doctor() {
    const chain = Number(BigInt(await this.provider.send('eth_chainId', [])));
    if (chain !== this.c.CHAIN_ID)
      throw Error(`RPC chain ${chain} does not match configured chain ${this.c.CHAIN_ID}`);
    const addresses = [this.c.V3_FACTORY, this.c.V3_ROUTER, this.c.V3_QUOTER, this.c.WETH];
    const codes = await Promise.all(addresses.map((a) => this.provider.getCode(a)));
    if (codes.some((x) => x === '0x'))
      throw Error('Factory, router, quoter or WETH has no deployed bytecode');
    const code = codes[1]!.toLowerCase();
    if (this.c.ROUTER_KIND === 'auto') {
      const classic = code.includes(CLASSIC.getFunction('exactInputSingle')!.selector.slice(2));
      const router02 = code.includes(ROUTER02.getFunction('exactInputSingle')!.selector.slice(2));
      if (classic === router02)
        throw Error(
          'Cannot uniquely identify router ABI. Inspect the verified source and set ROUTER_KIND explicitly.',
        );
      this.kind = classic ? 'classic' : 'router02';
    } else this.kind = this.c.ROUTER_KIND;
    for (const [address, abi] of [
      [this.c.V3_ROUTER, this.iface],
      [this.c.V3_QUOTER, QUOTER],
    ] as const) {
      const con = new Contract(address, abi, this.provider);
      if (getAddress(await con.getFunction('factory')()) !== this.c.V3_FACTORY)
        throw Error('Contract factory mismatch');
      if (getAddress(await con.getFunction('WETH9')()) !== this.c.WETH)
        throw Error('Contract WETH mismatch');
    }
    const weth = new Contract(this.c.WETH, ERC20, this.provider);
    if (Number(await weth.getFunction('decimals')()) !== 18)
      throw Error('WETH must have 18 decimals');
    return {
      chainId: chain,
      block: await this.provider.getBlockNumber(),
      routerKind: this.kind,
      contractsHaveCode: true,
    };
  }
  async discover(from: number, to: number): Promise<Candidate[]> {
    const event = FACTORY.getEvent('PoolCreated')!;
    const logs = await this.provider.getLogs({
      address: this.c.V3_FACTORY,
      topics: [event.topicHash],
      fromBlock: from,
      toBlock: to,
    });
    const out: Candidate[] = [];
    for (const log of logs) {
      const a = FACTORY.parseLog(log)!.args;
      const t0 = getAddress(a.token0),
        t1 = getAddress(a.token1);
      const fee = Number(a.fee);
      if (!this.c.FEE_TIERS.includes(fee) || ![t0, t1].includes(this.c.WETH)) continue;
      const block = await this.provider.getBlock(log.blockNumber);
      if (!block) throw Error('Creation block unavailable');
      out.push({
        pool: getAddress(a.pool),
        token: t0 === this.c.WETH ? t1 : t0,
        fee,
        block: log.blockNumber,
        blockHash: log.blockHash,
        createdAt: block.timestamp,
        status: 'waiting',
        reason: 'Waiting for funded liquidity',
        symbol: 'TOKEN',
        decimals: 18,
        nextTry: 0,
      });
    }
    return out;
  }
  async market(pool: string): Promise<Market> {
    const p = new Contract(pool, POOL, this.provider);
    const [t0, t1, factory, fee, liq, slot] = await Promise.all(
      ['token0', 'token1', 'factory', 'fee', 'liquidity', 'slot0'].map((fn) => p.getFunction(fn)()),
    );
    if (getAddress(factory) !== this.c.V3_FACTORY) throw Error('Foreign pool factory');
    if (![getAddress(t0), getAddress(t1)].includes(this.c.WETH))
      throw Error('Pool has no configured WETH');
    const token = getAddress(t0) === this.c.WETH ? getAddress(t1) : getAddress(t0);
    const f = new Contract(this.c.V3_FACTORY, FACTORY, this.provider);
    if (getAddress(await f.getFunction('getPool')(token, this.c.WETH, fee)) !== getAddress(pool))
      throw Error('Pool is not canonical');
    const erc = new Contract(token, ERC20, this.provider),
      w = new Contract(this.c.WETH, ERC20, this.provider);
    const [symbol, decimals, wethBalance] = await Promise.all([
      erc
        .getFunction('symbol')()
        .catch(() => 'TOKEN'),
      erc.getFunction('decimals')(),
      w.getFunction('balanceOf')(pool),
    ]);
    if (Number(decimals) > 36) throw Error('Unsupported token decimals');
    return {
      token,
      pool: getAddress(pool),
      fee: Number(fee),
      symbol: clean(symbol, 14) || 'TOKEN',
      decimals: Number(decimals),
      liquidity: BigInt(liq),
      wethBalance: BigInt(wethBalance),
      sqrt: BigInt(slot.sqrtPriceX96),
    };
  }
  async quote(m: Market, amount: bigint, sell = false): Promise<Quote> {
    if (amount <= 0n || m.sqrt === 0n) throw Error('Zero amount or uninitialized pool');
    const quoter = new Contract(this.c.V3_QUOTER, QUOTER, this.provider);
    const result = await quoter.getFunction('quoteExactInputSingle').staticCall({
      tokenIn: sell ? m.token : this.c.WETH,
      tokenOut: sell ? this.c.WETH : m.token,
      amountIn: amount,
      fee: m.fee,
      sqrtPriceLimitX96: 0,
    });
    const before = m.sqrt * m.sqrt,
      after = BigInt(result.sqrtPriceX96After) ** 2n;
    const move = ((after > before ? after - before : before - after) * 10000n) / before;
    return { out: BigInt(result.amountOut), priceMoveBps: Number(move), at: Date.now() };
  }
  async swapRequest(
    m: Market,
    amount: bigint,
    minimum: bigint,
    account: string,
    sell = false,
  ): Promise<TransactionRequest> {
    const block = await this.provider.getBlock('latest');
    if (!block) throw Error('Latest block unavailable');
    const deadline = block.timestamp + 60;
    const params = {
      tokenIn: sell ? m.token : this.c.WETH,
      tokenOut: sell ? this.c.WETH : m.token,
      fee: m.fee,
      recipient: sell ? this.c.V3_ROUTER : account,
      deadline,
      amountIn: amount,
      amountOutMinimum: minimum,
      sqrtPriceLimitX96: 0,
    };
    const calls = [this.iface.encodeFunctionData('exactInputSingle', [params])];
    if (sell) calls.push(this.iface.encodeFunctionData('unwrapWETH9', [minimum, account]));
    return {
      to: this.c.V3_ROUTER,
      data:
        this.kind === 'classic'
          ? this.iface.encodeFunctionData('multicall', [calls])
          : this.iface.encodeFunctionData('multicall', [deadline, calls]),
      value: sell ? 0n : amount,
    };
  }
}
