# Operation and recovery

## State

Each mode / chain / wallet has its own folder below `DATA_DIR`. The file
records pools, open and closed positions, receipt-based gas, the discovery
cursor and at most one pending signed transaction. A fingerprint also pins
the factory, router, quoter and WETH to that state.

Writes use a flushed temporary file and an atomic rename. An exclusive PID
lock refuses a second process. Stale locks are recovered only when their
process no longer exists on the same host. A corrupt or mismatched state is
not silently reset.

Back up the state before upgrading. **Do not delete live state to solve a
connection error:** doing so can lose position tracking and reset budgets.
Local state may contain an already signed transaction; do not publish it.

## If the process or RPC stops

Restart with the same wallet, mode, deployment and state directory. The bot
checks the saved transaction hash before signing anything new. If no receipt
is available it may rebroadcast the exact signed bytes; it never silently
signs a duplicate buy at a new nonce. An indefinitely pending transaction
holds the queue until its result can be reconciled.

If accounting is ambiguous, inspect the transaction receipt and local state
before continuing. The bot does not guess a fill, clear an unknown nonce or
automatically replace a transaction with a higher-fee transaction.

The discovery cursor uses confirmed blocks and stores its block hash. A
detected discovery reorganization rewinds 32 blocks and writes a persistent
entry pause. Review existing receipts before resuming. Deep reorganizations
of already settled trades require operator review; the bot does not invent
refunds by rolling back its own accounting.

## Exits

Live sells approve only the tracked token amount. A nonzero insufficient
allowance is first reset to zero, then set to the required amount. Approval
receipts are journaled like swaps, and each subsequent step requotes.

Both router variants use a 60-second on-chain deadline and nonzero minimum
output. Sells route WETH into the router and unwrap it to native ETH for the
same wallet. The final receipt's WETH withdrawal is used for proceeds.

An exit can fail because of token behavior, depleted liquidity, price changes,
RPC faults or configured gas limits. The position stays open and is retried;
no profit, close or refund is assumed. Pausing new entries keeps this
management running. Stopping the process does not sell or monitor holdings.

## Deployment

Development and review:

```bash
npm ci
npm run check
npm run doctor
```

For a lean installed runtime after building:

```bash
npm run build
npm prune --omit=dev
node dist/cli.js run --headless
```

Run under a process manager if continuous operation is needed, with the same
working directory and a persistent `data` volume. Do not share a signing
wallet between multiple bot processes. There is no HTTP server or public
management endpoint in this MVP.

The tests use Ganache in-process; no listening port is required. Some newer
Node versions print a Ganache native-WebSocket compatibility notice. Its
JavaScript fallback is sufficient for the tests and is not used by the bot.

The test suite uses the modular `@ganache/core` package. Its state manager
expects `@ethereumjs/util` 8.x but does not declare it as a runtime dependency;
the test environment therefore pins that package explicitly. Keep the lockfile
and this development-only compatibility dependency when updating fixtures.
