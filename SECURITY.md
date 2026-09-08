# Security

This is an unaudited trading MVP. Keep `.env`, private keys, state backups,
signed transactions and RPC credentials out of issues and pull requests.

Use private vulnerability reporting when the repository owner has enabled
it; otherwise contact the owner privately. Do not publish an exploit against
a funded wallet. The software does not collect keys or charge a platform fee.

Important boundaries:

- A reverse pool quote is not a honeypot test or proof that a token is safe.
- Liquidity checks do not prove locked LP ownership or prevent future rug pulls.
- The code supports standard V3 / PONS V2 / V4 native-ETH routes; fee-on-transfer and rebasing
  tokens are outside its supported scope.
- Entry limits and stop conditions reduce exposure but do not guarantee a
  profitable trade or an executable exit.
- A compromised local machine or RPC can invalidate operational assumptions.

Production dependencies and development-only EVM fixtures are separate.
The CI workflow does not request or use wallet keys.

- PONS curve entries wait for a readable recipient-specific opening tax and
  enforce configured fee/progress limits. These limits do not guarantee an exit.
- PONS graduation can pause trading. A tracked holding is never erased or
  refunded synthetically if the curve closes before its V4 pool is available.
- V4 Permit2 approvals use exact amounts and expiring router allowances.
  Factory and V4 deployment changes are refused for already pinned state.
