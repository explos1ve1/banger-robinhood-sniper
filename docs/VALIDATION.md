# Validation record

Checked on 2026-09-07 using Node.js 24.19.0, TypeScript 5.9.3 and ethers 6.17.0
on Linux. The included GitHub Actions workflow targets Node.js 22; it has not
yet run in a published GitHub repository.

| Check | Result |
| --- | --- |
| Fresh `npm ci` in a separate directory | Passed |
| Strict TypeScript checking | Passed |
| Unit and integration tests | 7 passed, 0 failed |
| Build and compiled offline demo | Passed |
| Production-only install and compiled demo | Passed |
| `npm audit --omit=dev` on the production-only install | 0 reported vulnerabilities at verification time |
| Banner and actual terminal preview | Rendered and visually inspected |

The integration test executes actual published Uniswap V3 contracts inside
an isolated EVM. It covers discovery, paper fills without wallet transactions,
ETH buys, exact approval, native ETH exits, both router ABIs, receipt-based
PNL, a rejected gas budget and recovery from an interrupted RPC response.

Fixtures use `@ganache/core` 0.10.2, V3 Core 1.0.1, V3 Periphery 1.4.4,
Swap Router Contracts 1.3.1 and Solidity 0.8.30. Test wallets are generated
locally and have no connection to a funded wallet.

**Not established by these checks:** Robinhood Chain mainnet connectivity,
live trades, profitability, transaction priority, token safety, or protection
against all RPC and blockchain failure modes. The public mainnet RPC could
not be verified from the build environment. Run `doctor` against a working
RPC before enabling a signer.

The dependency scan applies to production dependencies. The legacy test
fixtures include deprecated development dependencies; this is not a claim
that all development packages or the trading code have been security-audited.
