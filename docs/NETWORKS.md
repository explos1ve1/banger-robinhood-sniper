# Supported network and deployments

Checked against public documentation on September 8, 2026. Addresses below
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

PONS V1 launches can be observed through compatible WETH/V3 pools. PONS V2
uses its own launch events and bonding curves, then routes open positions to
a native ETH/V4 pool after graduation. PONS V1 early-window restrictions are
respected by simulation/revert handling. For V2, the opening tax is read for
the recipient and the default waits for it to reach zero.

| PONS / V4 component | Published address |
| --- | --- |
| Current PONS V2 factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Universal Router 2.1.1 | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

The hook is resolved from this factory and its reverse factory/manager
relationships are checked. Each candidate's curve, token and quote asset
must agree with its factory launch record. Older V2 deployments are not
silently mixed into the same state. Addresses were compared with:

- https://docs.ponsfamily.com/v2
- https://developers.uniswap.org/docs/protocols/v4/deployments
- https://github.com/Uniswap/sdks/blob/main/sdks/universal-router-sdk/src/utils/constants.ts

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
