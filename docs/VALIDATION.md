# Validation record

Checked on **2026-09-08** for BANGER **0.2.0**, using Node.js 24.19.0,
TypeScript 5.9.3 and ethers 6.17.0 on Linux. Changes are based on repository
commit `c14fcb0fe1ded18bca5972958e4db2fef2074cf0`.

| Check | Result |
| --- | --- |
| Clean dependency installation from the final lockfile, `npm ci --offline --no-audit --no-fund` | Passed; cached packages installed successfully |
| `npm run format:check` | Passed |
| Strict TypeScript checking | Passed |
| Complete unit and integration suite | **10 passed, 0 failed, 0 skipped** |
| TypeScript build | Passed |
| Compiled offline terminal, `node dist/cli.js demo --once` | Passed; no RPC or signer required |

The included GitHub Actions workflow targets Node.js 22 on Ubuntu. A remote
Actions run and a Windows installation have not been verified in this build.

## What the tests establish

The V3 integration test executes published Uniswap V3 contracts in an isolated
EVM. It covers discovery, paper fills without wallet transactions, ETH buys,
exact approval, native ETH exits, both supported V3 router ABIs, receipt-based
PNL, a rejected gas budget and recovery from an interrupted RPC response.

The PONS integration test runs against a local Anvil node with generated,
locally funded test wallets. It covers:

- Confirmed factory-event discovery and rejection of non-native quote assets.
- Waiting when the reported opening tax exceeds the configured limit.
- Curve buys, exact token approvals and curve sells for native ETH.
- A clamped buy with an ETH refund, actual-spend cost basis and receipt PNL.
- Recovery of a submitted buy after an interrupted receipt response, without
  submitting a second purchase.
- Retaining a position while its curve is closed or graduation is pending.
- A factory phase change followed by an exit through an actual V4 PoolManager,
  PONS fee hook, V4 Quoter, Permit2 and modern Universal Router.
- Exact ERC20 approval, expiring Permit2 allowance, net native ETH settlement,
  hook fees and receipt-based realized PNL on that V4 exit.

Unit tests also check integer fee rounding, the clamped-buy rate bound,
phantom-reserve rejection, configuration constraints, and modern V4 calldata.

## Fixture scope

PONS sources are pinned to
`ponsdotdev/ponsfamily@8b9bf371030279133017b5c1b713823f5889c5d2`.
The published base `PonsV2BondingCurve` and `PonsV2MemeHook` are compiled from
unchanged source snapshots. The public base-curve source at this revision
does not include the opening-tax getter used by the current documented API.
The local curve subclass supplies that getter for testing the entry gate;
actual curve execution is tested at **zero opening tax**. This is not a test
of production opening-tax execution. The runtime adapter requires the getter
to succeed and does not silently treat a failed call as zero tax.

The fixture factory controls launch records and graduation phases and seeds
local V4 liquidity. It does not reproduce the entire production factory,
keeper, rescue, or graduation transaction. The PONS fee hook itself is the
published implementation and participates in the tested V4 swap.

Modern Universal Router test sources are pinned to
`Uniswap/universal-router@fb25ff09c71dcfc13665e6c65788db737f29e0d4`.
This newer router implementation supports the 2.1.1 V4 tuple used by the
configured Robinhood Chain deployment, including `minHopPriceX36`. Passing
against this fixture is not a byte-for-byte test of that deployed router.
The test uses official Permit2 bytecode installed at its canonical address
inside the **local** chain. See [third-party notices](../THIRD_PARTY_NOTICES.md)
for source revisions, license notices and the legacy V3 dependency adaptation.

Solidity fixtures use pinned npm dependencies and source snapshots. The V3
test uses Ganache; PONS/V4 uses Anvil. On Node.js 24, Ganache emits a native
µWS compatibility notice and successfully uses its JavaScript fallback.
This notice does not affect the production CLI.

## Not established by these checks

Robinhood Chain mainnet connectivity and live trades were **not verified**.
The public RPC timed out from the build environment. No real funds were used.
Contract addresses and interfaces were checked against primary documentation,
but deployed bytecode was not independently matched to those sources.

These tests do not establish profitability, transaction priority, token safety,
or protection against every RPC and blockchain failure mode. Run `doctor`
against a working RPC and begin in watch/paper mode. A passing `doctor` checks
deployment consistency; it is not a contract audit.

No new dependency vulnerability scan was performed for this update. The
development dependencies include legacy packages used by contract tests.
