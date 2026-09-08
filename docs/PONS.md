# PONS V2 in BANGER

Set `VENUES=both` in your local `.env` to scan V3 and PONS V2, or `VENUES=pons`
for PONS V2 only. Run `npm ci`, `npm run doctor`, then start in watch/paper mode.
The new example configuration already selects both. The code default remains
V3 to preserve the behavior of existing installations without that setting.

## What happens to a launch

1. The scanner indexes confirmed `TokenLaunched` events from the configured
   PONS factory. Non-native quote assets are skipped.
2. The factory record, curve, token, quote currency and hook must agree.
   Curve state is read at one block, including real reserves, fee rates,
   recipient-specific opening tax and graduation progress.
3. New entries require enough real ETH, acceptable fees and price movement,
   and progress below the configured entry limit. The default opening-tax
   cap is zero, so BANGER waits for the tax to decay completely.
4. A buy sends native ETH directly to the curve. A sell approves only the
   required token amount to that curve and receives native ETH.
5. At the exit-progress threshold the bot attempts an early exit. If another
   trade finishes the curve first, the position stays recorded. While the
   factory reports `Swept`, the bot waits for pool creation and retries quotes.
6. Once `PoolCreated` is reported, the bot resolves the V4 pool key and attempts
   a full exit using the V4 Quoter and Universal Router. It does not open new
   V4 positions. The real PONS hook fee is included in the quote and settlement.

The target feed shows PONS curve progress. Trade sizes, session spend, gas,
open positions, realized PNL and quoted unrealized PNL share the existing ledger.

## Fill and allowance accounting

- Curve buys can be clamped at graduation. `CurveBuy` and `CurveBuyRefunded`
  determine the amount actually spent. Token transfers must agree with the
  fill event. A refund is not counted as an investment or a profit.
- A clamped buy enforces a price bound. BANGER scales `minTokensOut` to the
  full offered ETH amount and validates the actual fill's rate in the receipt.
- Curve sells use the net `CurveSell` quote output and verify the tracked
  token debit. V3 and V4 native exits use a verified WETH withdrawal event.
- V4 exits grant the exact token amount to Permit2 and a short-lived,
  exact-amount Permit2 allowance to the router. Approvals are confirmed before
  a new exit quote. No unlimited approval is requested by the engine.
- A V4 native exit wraps and immediately unwraps the received ETH inside the
  same atomic transaction. This adds some gas but produces an exact receipt
  amount without guessing from wallet balance changes.
- Pending transactions retain their execution route. A restart reconciles
  the same signed bytes before any new transaction can be signed.

## Scope and operational limits

Only native-ETH PONS V2 launches from the configured factory are supported.
Changing the PONS/V4 deployment after it has been pinned requires separate
state; keep the original configuration available to manage old holdings.
Disabling discovery for a venue does not stop management of existing positions.
Original V3 state files remain readable, and enabling PONS does not reset budgets.

The bot does not launch tokens, submit bundles, bypass the opening tax, start
graduation transactions, rescue swept launches, or claim creator fees. A stalled
graduation may delay an exit indefinitely; a rescued launch is reported and
retained for operator review. An early-exit threshold cannot guarantee that
the curve will still be open when a sell reaches it.

PONS curve calls have no on-chain deadline parameter. Fresh-quote checks and
minimum outputs bound the submitted price, but a pending curve transaction can
settle later. V4 and V3 calls also have router deadlines. Never manually erase
a pending transaction to force another buy.

Paper trades do not move real reserves. Their hypothetical fills cannot prove
sellability or profitability. Mainnet trades have not been tested in this build.
The local contract test scope is recorded in [VALIDATION.md](VALIDATION.md).

## Primary references

- https://docs.ponsfamily.com/v2
- https://github.com/ponsdotdev/ponsfamily
- https://developers.uniswap.org/docs/protocols/v4/deployments
- https://github.com/Uniswap/sdks/blob/main/sdks/universal-router-sdk/src/utils/constants.ts

Deployment references were checked on September 8, 2026. `doctor` verifies
runtime consistency; it is not a contract audit or a bytecode/source audit.
