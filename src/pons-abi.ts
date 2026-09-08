import { Interface } from 'ethers';

// PONS interfaces: https://docs.ponsfamily.com/v2 (2026-09-08).
// A curve and its launch record are always resolved from the configured factory.
export const PONS_FACTORY = new Interface([
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
  'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function poolManager() view returns (address)',
  'function memeHook() view returns (address)',
  'function permit2() view returns (address)',
]);
export const CURVE = new Interface([
  'function factory() view returns (address)',
  'function token() view returns (address)',
  'function pairToken() view returns (address)',
  'function feePolicy() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address) view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256)',
  'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)',
  'event CurveBuyRefunded(address indexed buyer,uint256 refund)',
  'event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)',
]);
export const HOOK = new Interface([
  'function factory() view returns (address)',
  'function poolManager() view returns (address)',
]);
export const POOL_KEY =
  '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const V4_QUOTER = new Interface([
  'function poolManager() view returns (address)',
  `function quoteExactInputSingle((${POOL_KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`,
]);
export const STATE_VIEW = new Interface([
  'function poolManager() view returns (address)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);
export const UNIVERSAL = new Interface([
  'function poolManager() view returns (address)',
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
]);
export const PERMIT2 = new Interface([
  'function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
]);
export const V4_MANAGER = new Interface([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
]);
