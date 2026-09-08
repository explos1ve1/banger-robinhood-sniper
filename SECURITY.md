# Security

This is an unaudited trading MVP. Keep `.env`, private keys, state backups,
signed transactions and RPC credentials out of issues and pull requests.

Use private vulnerability reporting when the repository owner has enabled
it; otherwise contact the owner privately. Do not publish an exploit against
a funded wallet. The software does not collect keys or charge a platform fee.

Important boundaries:

- A reverse pool quote is not a honeypot test or proof that a token is safe.
- Liquidity checks do not prove locked LP ownership or prevent future rug pulls.
- The code supports standard V3 / ERC-20 behavior; fee-on-transfer and rebasing
  tokens are outside its supported scope.
- Entry limits and stop conditions reduce exposure but do not guarantee a
  profitable trade or an executable exit.
- A compromised local machine or RPC can invalidate operational assumptions.

Production dependencies and development-only EVM fixtures are separate.
The CI workflow does not request or use wallet keys.
