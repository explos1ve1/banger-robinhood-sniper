import { AbiCoder, Contract, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { ERC20 } from './abi.js';
import { PERMIT2, POOL_KEY, STATE_VIEW, UNIVERSAL, V4_QUOTER } from './pons-abi.js';
import type { Config } from './config.js';
import type { Market, Quote, RpcProvider } from './v3.js';

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}
const coder = AbiCoder.defaultAbiCoder();
const THIS = '0x0000000000000000000000000000000000000002';
const MAX128 = (1n << 128n) - 1n;
export const poolId = (key: PoolKey) => keccak256(coder.encode([POOL_KEY], [key]));

export class V4 {
  constructor(
    readonly c: Config,
    readonly provider: RpcProvider,
  ) {}
  async doctor() {
    for (const a of [
      this.c.V4_POOL_MANAGER,
      this.c.V4_ROUTER,
      this.c.V4_QUOTER,
      this.c.V4_STATE_VIEW,
      this.c.PERMIT2,
      this.c.WETH,
    ])
      if ((await this.provider.getCode(a)) === '0x')
        throw Error('Missing V4 / Permit2 / WETH contract');
    for (const [address, abi] of [
      [this.c.V4_ROUTER, UNIVERSAL],
      [this.c.V4_QUOTER, V4_QUOTER],
      [this.c.V4_STATE_VIEW, STATE_VIEW],
    ] as const) {
      const contract = new Contract(address, abi, this.provider);
      if (getAddress(await contract.getFunction('poolManager')()) !== this.c.V4_POOL_MANAGER)
        throw Error('V4 router / quoter / view PoolManager mismatch');
    }
    const weth = new Contract(this.c.WETH, ERC20, this.provider);
    if (Number(await weth.getFunction('decimals')()) !== 18)
      throw Error('WETH must have 18 decimals');
  }
  async market(m: Market, block: number): Promise<Market> {
    const key = m.pons!.key;
    const id = poolId(key);
    const view = new Contract(this.c.V4_STATE_VIEW, STATE_VIEW, this.provider);
    const [slot, liquidity] = await Promise.all([
      view.getFunction('getSlot0')(id, { blockTag: block }),
      view.getFunction('getLiquidity')(id, { blockTag: block }),
    ]);
    m.sqrt = BigInt(slot[0]);
    m.liquidity = BigInt(liquidity);
    if (m.sqrt <= 0n || m.liquidity <= 0n) throw Error('PONS V4 pool has no active liquidity');
    // Virtual active-range quote liquidity, NOT PoolManager's shared ETH balance.
    m.wethBalance = (m.liquidity * (1n << 96n)) / m.sqrt;
    return m;
  }
  async quote(m: Market, amount: bigint, sell = false): Promise<Quote> {
    if (amount <= 0n || amount > MAX128) throw Error('V4 input outside uint128 range');
    const quoter = new Contract(this.c.V4_QUOTER, V4_QUOTER, this.provider);
    const result = await quoter.getFunction('quoteExactInputSingle').staticCall({
      poolKey: m.pons!.key,
      zeroForOne: !sell,
      exactAmount: amount,
      hookData: '0x',
    });
    const out = BigInt(result[0]);
    if (out <= 0n) throw Error('V4 quote returned zero');
    const squared = m.sqrt * m.sqrt;
    const spotOut = sell ? (amount * (1n << 192n)) / squared : (amount * squared) / (1n << 192n);
    const priceMoveBps =
      spotOut > out && spotOut > 0n ? Number(((spotOut - out) * 10000n) / spotOut) : 0;
    return { out, priceMoveBps, at: Date.now() };
  }
  async approval(m: Market, account: string, amount: bigint) {
    if (amount <= 0n || amount > MAX128) throw Error('V4 approval outside supported amount');
    const token = new Contract(m.token, ERC20, this.provider);
    const allowance = BigInt(await token.getFunction('allowance')(account, this.c.PERMIT2));
    if (allowance < amount) {
      const value = allowance > 0n ? 0n : amount;
      return {
        request: {
          to: m.token,
          data: ERC20.encodeFunctionData('approve', [this.c.PERMIT2, value]),
        },
        amount: value,
      };
    }
    const block = await this.provider.getBlock('latest');
    if (!block) throw Error('Cannot set Permit2 expiration');
    const permit = new Contract(this.c.PERMIT2, PERMIT2, this.provider);
    const allowed = await permit.getFunction('allowance')(account, m.token, this.c.V4_ROUTER);
    if (BigInt(allowed[0]) < amount || Number(allowed[1]) < block.timestamp + 90) {
      return {
        request: {
          to: this.c.PERMIT2,
          data: PERMIT2.encodeFunctionData('approve', [
            m.token,
            this.c.V4_ROUTER,
            amount,
            block.timestamp + 300,
          ]),
        },
        amount,
      };
    }
    return null;
  }
  async swapRequest(m: Market, amount: bigint, minimum: bigint, account: string, sell = false) {
    if (amount <= 0n || amount > MAX128 || minimum <= 0n || minimum > MAX128)
      throw Error('Invalid V4 swap bounds');
    const block = await this.provider.getBlock('latest');
    if (!block) throw Error('Cannot set V4 deadline');
    const key = m.pons!.key;
    if (key.currency0 !== ZeroAddress || key.currency1 !== m.token)
      throw Error('Only native ETH PONS V4 pairs are supported');
    const modern = this.c.V4_ROUTER_VERSION === '2.1.1';
    const swapType = `(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,${modern ? 'uint256 minHopPriceX36,' : ''}bytes hookData)`;
    const swap = coder.encode(
      [swapType],
      [[key, !sell, amount, minimum, ...(modern ? [0n] : []), '0x']],
    );
    const settlement = coder.encode(['address', 'uint256'], [sell ? m.token : ZeroAddress, amount]);
    const take = sell
      ? coder.encode(['address', 'address', 'uint256'], [ZeroAddress, THIS, 0n])
      : coder.encode(['address', 'uint256'], [m.token, minimum]);
    const actions = coder.encode(
      ['bytes', 'bytes[]'],
      [sell ? '0x060c0e' : '0x060c0f', [swap, settlement, take]],
    );
    // On an ETH exit, wrap and immediately unwrap within the SAME transaction.
    // This leaves native ETH with the wallet and a WETH Withdrawal receipt for
    // exact accounting, including the PONS hook fee. No balance-difference guesses.
    const inputs = sell
      ? [
          actions,
          coder.encode(['address', 'uint256'], [THIS, 1n << 255n]),
          coder.encode(['address', 'uint256'], [account, minimum]),
        ]
      : [actions, coder.encode(['address', 'address', 'uint256'], [ZeroAddress, account, 0n])];
    return {
      to: this.c.V4_ROUTER,
      data: UNIVERSAL.encodeFunctionData('execute', [
        sell ? '0x100b0c' : '0x1004',
        inputs,
        block.timestamp + 60,
      ]),
      value: sell ? 0n : amount,
    };
  }
}
