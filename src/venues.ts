import { Contract, ZeroAddress } from 'ethers';
import { ERC20 } from './abi.js';
import type { Config } from './config.js';
import { Pons } from './pons.js';
import { V3, type Market, type RpcProvider } from './v3.js';
import type { Candidate } from './store.js';

export class Venues {
  readonly v3: V3;
  readonly pons: Pons;
  constructor(
    readonly c: Config,
    readonly provider: RpcProvider,
    account = ZeroAddress,
  ) {
    this.v3 = new V3(c, provider);
    this.pons = new Pons(c, provider, account);
  }
  async doctor(managePons = false, manageV3 = false) {
    const chainId = Number(BigInt(await this.provider.send('eth_chainId', [])));
    if (chainId !== this.c.CHAIN_ID) throw Error('RPC chain ID mismatch');
    const v3 = this.c.VENUES !== 'pons' || manageV3 ? await this.v3.doctor() : null;
    const pons = this.c.VENUES !== 'v3' || managePons ? await this.pons.doctor() : null;
    return {
      chainId,
      block: await this.provider.getBlockNumber(),
      routerKind: v3?.routerKind ?? 'pons-v2',
      v3,
      pons,
    };
  }
  enabled(venue: Candidate['venue']) {
    return (
      (venue === 'pons' && this.c.VENUES !== 'v3') || (venue !== 'pons' && this.c.VENUES !== 'pons')
    );
  }
  async discover(from: number, to: number) {
    const jobs: Promise<Candidate[]>[] = [];
    if (this.c.VENUES !== 'pons') jobs.push(this.v3.discover(from, to));
    if (this.c.VENUES !== 'v3') jobs.push(this.pons.discover(from, to));
    return (await Promise.all(jobs)).flat();
  }
  market(pool: string, venue: Candidate['venue'] = 'v3') {
    return venue === 'pons' ? this.pons.market(pool) : this.v3.market(pool);
  }
  quote(m: Market, amount: bigint, sell = false) {
    return m.venue === 'pons' ? this.pons.quote(m, amount, sell) : this.v3.quote(m, amount, sell);
  }
  swapRequest(m: Market, amount: bigint, minimum: bigint, account: string, sell = false) {
    return m.venue === 'pons'
      ? this.pons.swapRequest(m, amount, minimum, account, sell)
      : this.v3.swapRequest(m, amount, minimum, account, sell);
  }
  entryCheck(m: Market) {
    if (!this.enabled(m.venue)) throw Error('Entry venue disabled');
    if (m.venue === 'pons') return this.pons.entryCheck(m);
    if (m.liquidity === 0n || m.wethBalance < this.c.MIN_POOL_WETH_ETH)
      throw Error('Waiting for active liquidity and minimum WETH balance');
  }
  async approval(m: Market, account: string, amount: bigint) {
    if (m.route === 'v4') return this.pons.v4.approval(m, account, amount);
    const spender = m.route === 'curve' ? m.pool : this.c.V3_ROUTER;
    const token = new Contract(m.token, ERC20, this.provider);
    const allowance = BigInt(await token.getFunction('allowance')(account, spender));
    if (allowance >= amount) return null;
    const value = allowance > 0n ? 0n : amount;
    return {
      request: { to: m.token, data: ERC20.encodeFunctionData('approve', [spender, value]) },
      amount: value,
    };
  }
}
