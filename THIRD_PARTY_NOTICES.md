# Third-party test sources

BANGER's own code is distributed under the root MIT license. The Solidity
source snapshots used only by the local integration tests retain their own
SPDX identifiers and upstream licenses. They are not included in `dist/`.

| Source | Pinned revision | Included material |
| --- | --- | --- |
| [PONS Family](https://github.com/ponsdotdev/ponsfamily) | `8b9bf371030279133017b5c1b713823f5889c5d2` | Base bonding curve, fee hook and supporting MIT sources in `test/fixtures/pons-sources.json` |
| [Universal Router](https://github.com/Uniswap/universal-router) | `fb25ff09c71dcfc13665e6c65788db737f29e0d4` | Router sources in `test/fixtures/modern-router-sources.json`; GPL-3.0-or-later and individual file licenses |
| [V4 Periphery](https://github.com/Uniswap/v4-periphery) | `07336f2144f522874e2c3c85e04d1d3f8d5fa471` | Supporting interfaces and action code; individual MIT/GPL identifiers |
| [Permit2](https://github.com/Uniswap/permit2) | `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219` | Interfaces and libraries; MIT, copyright 2022 Uniswap Labs |
| [Solmate](https://github.com/transmissions11/solmate) | `8d910d876f51c3b2585c9109409d601f600e68e1` | Utilities; individual MIT/AGPL identifiers |
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | PONS snapshot and npm `5.0.2` | MIT supporting interfaces and utilities |
| [V3 Periphery](https://github.com/Uniswap/v3-periphery) | npm `1.4.4` | Legacy router dependencies; GPL-2.0-or-later and individual file licenses |

License texts are in `licenses/`. Copyright and license notices in the source
snapshots remain intact. Other installed dependencies carry their licenses
in their respective npm packages; exact versions are pinned by the lockfile.

The modern-router snapshot has one compatibility edit in the legacy V3
`PoolAddress` dependency: explicit `uint160` narrowing for Solidity 0.8,
preserving its low-160-bit address calculation. Test compilation also maps
legacy ERC721 interface import paths to the OpenZeppelin 5 extension paths.
V4 swap logic is unchanged. Snapshot metadata records these adaptations.

`PonsFixture.sol` is a local test harness. It supplies a factory, liquidity
setup, and a getter shim around the published base curve; it is not a
deployment of the production PONS factory. See [validation scope](docs/VALIDATION.md).
