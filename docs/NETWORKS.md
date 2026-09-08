# Supported network and deployments

Checked against public documentation on September 7, 2026. Addresses below
are configuration candidates, not a claim that they were audited or verified
through a working mainnet RPC in this environment.

| Property | Example value |
| --- | --- |
| Network | Robinhood Chain |
| Chain ID | `4663` |
| Native gas token | ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Swap router | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Quoter V2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| Default fee tier | `10000` = 1% pool fee |

## Sources

- Robinhood connection details: https://docs.robinhood.com/chain/connecting/
- Canonical token contracts: https://docs.robinhood.com/chain/contracts/
- PONS deployment documentation: https://docs.ponsfamily.com/
- Public PONS source: https://github.com/ponsdotdev/ponsfamily
- Uniswap V3 integration: https://developers.uniswap.org/docs/protocols/v3/guides/swapping/getting-started
- ethers contract API: https://docs.ethers.org/v6/api/contract/

The public PONS source distinguishes V1's Uniswap V3 launches from V2's
bonding curve and graduated V4 pools. BANGER's current adapter supports
the former mechanism with WETH. It does not trade V2 curves or V4 pools.
PONS V1 can enforce early buy restrictions; BANGER respects call reverts
and retries within the configured entry-age window.

`doctor` checks the RPC chain ID, nonempty bytecode, router and quoter
factory/WETH getters, and the router selector. Each candidate is checked
against the canonical factory's `getPool`, token pair and fee. These are
consistency checks, not source-code verification or an audit. Independently
check contract provenance and deployed bytecode before live use.

The initial mainnet RPC probe timed out in the build environment. Configure
a working public or provider RPC from the official Robinhood documentation.
There is no hard-coded claim of mainnet connectivity in the terminal.

## Other deployments

For an isolated test or another compatible deployment, explicitly set the
chain ID, RPC, factory, router, quoter and WETH together. Use a new DATA_DIR
when changing identity. Never reuse mainnet addresses on testnet merely
because the chain is EVM-compatible. Automatic ABI detection fails closed
for an unrecognized or ambiguous router; review verified source before
setting `ROUTER_KIND=classic` or `router02` manually.
