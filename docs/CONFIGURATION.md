# Configuration reference

Environment variables override values in the local `.env` file. Amounts are
decimal ETH strings and are converted to integer wei. Basis points: 100 = 1%.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MODE` | `watch` | `watch`, `paper` or `live`. |
| `RPC_URL` | Official public RPC | HTTP(S) JSON-RPC endpoint. |
| `CHAIN_ID` | `4663` | Must match the RPC. |
| `V3_FACTORY`, `V3_ROUTER`, `V3_QUOTER`, `WETH` | See `.env.example` | Reviewed deployment addresses. |
| `ROUTER_KIND` | `auto` | Detect classic or Router02 exact-input selector. |
| `VENUES` | `v3` (example: `both`) | `v3`, `pons`, or `both`; affects new discovery and entries, not management of existing positions. |
| `PONS_V2_FACTORY` | See `.env.example` | Current PONS deployment to index. Pinned in the persisted state once enabled. |
| `V4_POOL_MANAGER`, `V4_ROUTER`, `V4_QUOTER`, `V4_STATE_VIEW`, `PERMIT2` | See `.env.example` | V4 exit deployment; checked against PONS factory and hook relationships. |
| `V4_ROUTER_VERSION` | `2.1.1` | Robinhood uses the modern single-hop tuple including `minHopPriceX36`. `2.0` is available for isolated older deployments. |
| `PONS_MIN_REAL_ETH` | `0.01` | Minimum real tradeable ETH reserve; excludes phantom reserves and accrued fees. |
| `PONS_MAX_FEE_BPS` | `500` | Maximum base fee plus creator tax on a curve entry (5%). |
| `PONS_MAX_SNIPE_TAX_BPS` | `0` | Wait until the recipient's opening snipe tax is zero. Unreadable tax fails closed. |
| `PONS_MAX_PROGRESS_BPS` | `8500` | Refuse new entries at or beyond 85% graduation progress. |
| `PONS_EXIT_PROGRESS_BPS` | `9500` | Attempt an early exit at 95% progress; must exceed entry threshold. |
| `FEE_TIERS` | `10000` | Comma-separated allowed V3 fee tiers. |
| `BUY_ETH` | `0.001` | Maximum offered ETH per entry. A clamped PONS purchase can spend less and refund the difference. |
| `MAX_SESSION_SPEND_ETH` | `0.01` | Gross buy principal cap across this persisted state, including closed positions. |
| `MAX_OPEN_POSITIONS` | `3` | Concurrent position limit. |
| `MAX_SESSION_LOSS_ETH` | `0.003` | Stops new entries when realized plus marked open PNL reaches this loss. |
| `MIN_POOL_WETH_ETH` | `0.05` | Minimum WETH token balance of the pool; not a liquidity-lock guarantee. |
| `SLIPPAGE_BPS` | `100` | Minimum output discount from a fresh quote. Must remain nonzero after rounding. |
| `MAX_PRICE_MOVE_BPS` | `500` | Maximum spot-price movement implied by a proposed entry quote. |
| `TAKE_PROFIT_BPS` | `3000` | +30% of position basis; incurred gas is part of basis in live mode. |
| `STOP_LOSS_BPS` | `1500` | −15% of position basis. A condition to attempt a sell, not a guaranteed exit price. |
| `MAX_HOLD_SECONDS` | `900` | Attempt a full exit after 15 minutes. |
| `MAX_GAS_PER_TX_ETH` | `0.001` | Gas limit × maximum fee per gas must fit this bound. |
| `MAX_FEE_GWEI` | `3` | Maximum offered gas price / max fee per gas. |
| `PAPER_START_ETH` | `0.1` | Virtual initial paper bankroll. |
| `POLL_MS` | `2000` | Loop interval; failures back off to at most 30 seconds. |
| `CONFIRMATIONS` | `3` | Discovery and receipt confirmation depth. |
| `LOOKBACK_BLOCKS` | `1000` | Initial discovery history; restart uses the saved cursor. |
| `LOG_CHUNK_BLOCKS` | `250` | Initial log range, reduced when an RPC rejects a large range. |
| `MIN_POOL_AGE_BLOCKS` | `3` | Earliest creation-block age for entry checks. |
| `MAX_POOL_AGE_SECONDS` | `300` | Entry opportunity expires after five minutes. |
| `RPC_TIMEOUT_MS` | `10000` | HTTP request timeout. |
| `TX_WAIT_MS` | `45000` | Receipt wait before handing off to persistent recovery. |
| `DATA_DIR` | `./data` | Private local state root. |
| `PRIVATE_KEY` | empty | Live signer only. Discarded from configuration in watch/paper. |
| `LIVE_ACK` | empty | Must exactly equal `I_ACCEPT_REAL_TRADES` for live mode. |

One session means the lifetime of a state directory, **not one process run**.
Restarting does not reset spend, loss or position tracking. Use separate
wallets/state roots for independent strategies and do not run two instances
against the same wallet with different directories.

Quote data can become stale. New entries pause if an open position has no
successful quote within 30 seconds. Stops and take-profits are evaluated on
available quotes; failed quotes do not invent a close or refund.
