import { z } from 'zod';
import { getAddress, parseEther, parseUnits, ZeroAddress } from 'ethers';

const integer = (d: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(d);
const eth = (d: string) =>
  z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/)
    .default(d)
    .transform(parseEther);
const address = z.string().transform((s, ctx) => {
  try {
    const a = getAddress(s);
    if (a === ZeroAddress) throw Error();
    return a;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a non-zero EVM address' });
    return z.NEVER;
  }
});
const schema = z.object({
  MODE: z.enum(['watch', 'paper', 'live']).default('watch'),
  RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: integer(4663, 1),
  V3_FACTORY: address.default('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'),
  V3_ROUTER: address.default('0xCaf681a66D020601342297493863E78C959E5cb2'),
  V3_QUOTER: address.default('0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7'),
  WETH: address.default('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  ROUTER_KIND: z.enum(['auto', 'classic', 'router02']).default('auto'),
  VENUES: z.enum(['v3', 'pons', 'both']).default('v3'),
  PONS_V2_FACTORY: address.default('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'),
  V4_POOL_MANAGER: address.default('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  V4_ROUTER: address.default('0x8876789976decbfcbbbe364623c63652db8c0904'),
  V4_ROUTER_VERSION: z.enum(['2.0', '2.1.1']).default('2.1.1'),
  V4_QUOTER: address.default('0x8dc178efb8111bb0973dd9d722ebeff267c98f94'),
  V4_STATE_VIEW: address.default('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
  PERMIT2: address.default('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  PONS_MIN_REAL_ETH: eth('0.01'),
  PONS_MAX_FEE_BPS: integer(500, 0, 2000),
  PONS_MAX_SNIPE_TAX_BPS: integer(0, 0, 9900),
  PONS_MAX_PROGRESS_BPS: integer(8500, 1, 9999),
  PONS_EXIT_PROGRESS_BPS: integer(9500, 1, 9999),
  FEE_TIERS: z
    .string()
    .default('10000')
    .transform((s) => s.split(',').map(Number))
    .refine(
      (a) => a.length > 0 && a.every((n) => Number.isInteger(n) && n > 0 && n <= 100000),
      'Invalid fee tiers',
    ),
  BUY_ETH: eth('0.001'),
  MAX_SESSION_SPEND_ETH: eth('0.01'),
  MAX_OPEN_POSITIONS: integer(3, 1, 100),
  MAX_SESSION_LOSS_ETH: eth('0.003'),
  MIN_POOL_WETH_ETH: eth('0.05'),
  SLIPPAGE_BPS: integer(100, 1, 3000),
  MAX_PRICE_MOVE_BPS: integer(500, 1, 5000),
  TAKE_PROFIT_BPS: integer(3000, 1, 10000000),
  STOP_LOSS_BPS: integer(1500, 1, 9500),
  MAX_HOLD_SECONDS: integer(900, 1),
  MAX_GAS_PER_TX_ETH: eth('0.001'),
  MAX_FEE_GWEI: z
    .string()
    .default('3')
    .transform((s) => parseUnits(s, 'gwei')),
  PAPER_START_ETH: eth('0.1'),
  POLL_MS: integer(2000, 100, 60000),
  CONFIRMATIONS: integer(3, 1, 100),
  LOOKBACK_BLOCKS: integer(1000, 0, 100000),
  LOG_CHUNK_BLOCKS: integer(250, 1, 10000),
  MIN_POOL_AGE_BLOCKS: integer(3, 1),
  MAX_POOL_AGE_SECONDS: integer(300, 1),
  RPC_TIMEOUT_MS: integer(10000, 1000, 60000),
  TX_WAIT_MS: integer(45000, 1000, 300000),
  DATA_DIR: z.string().default('./data'),
  PRIVATE_KEY: z.string().default(''),
  LIVE_ACK: z.string().default(''),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = schema.parse(env);
  if (!['http:', 'https:'].includes(new URL(c.RPC_URL).protocol))
    throw Error('RPC_URL must use HTTP(S)');
  if (c.BUY_ETH <= 0n || c.MAX_SESSION_SPEND_ETH < c.BUY_ETH)
    throw Error('Buy size must be positive and within the session budget');
  if (c.MAX_GAS_PER_TX_ETH <= 0n || c.MAX_FEE_GWEI <= 0n || c.MAX_SESSION_LOSS_ETH <= 0n)
    throw Error('Gas and loss limits must be positive');
  if (
    c.MODE === 'live' &&
    (c.LIVE_ACK !== 'I_ACCEPT_REAL_TRADES' || !/^0x[0-9a-fA-F]{64}$/.test(c.PRIVATE_KEY))
  )
    throw Error('Live mode requires a local PRIVATE_KEY and LIVE_ACK=I_ACCEPT_REAL_TRADES');
  // A read-only run never retains a accidentally configured signing key.
  if (c.MODE !== 'live') c.PRIVATE_KEY = '';
  if (c.PONS_EXIT_PROGRESS_BPS <= c.PONS_MAX_PROGRESS_BPS)
    throw Error('PONS_EXIT_PROGRESS_BPS must exceed PONS_MAX_PROGRESS_BPS');
  return c;
}
export function minOut(quote: bigint, bps: number): bigint {
  if (quote <= 0n || !Number.isInteger(bps) || bps < 0 || bps >= 10000)
    throw Error('Invalid quote or slippage');
  const out = (quote * BigInt(10000 - bps)) / 10000n;
  if (out <= 0n) throw Error('Minimum output rounds to zero');
  return out;
}
export const clean = (s: unknown, max = 32) =>
  String(s)
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, max);
export function safeError(e: unknown): string {
  // RPC errors can include complete requests, URLs or signed transactions.
  const x = e as { code?: string; shortMessage?: string; message?: string };
  if (x.code) return clean(x.code, 60);
  return clean(x.shortMessage ?? x.message ?? 'Unknown error', 160)
    .replace(/0x[0-9a-fA-F]{64,}/g, '[redacted]')
    .replace(/https?:\/\/\S+/g, '[RPC]');
}
