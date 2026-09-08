# Contributing

Run `npm ci`, `npm run format` and `npm run check`. Changes to execution, recovery, receipt
accounting or contract interfaces should include a relevant local EVM test.
Do not replace real-contract integration tests with a mock that merely
returns the expected number.

Keep network-specific addresses documented with primary sources. State any
mainnet validation limitations. Do not add wallet telemetry, embedded fee
recipients, profit claims, hard-coded secret values or misleading audit badges.

Use descriptive commits and explain the observed problem, resulting behavior
and validation in a pull request. Keep generated `data`, `.env` and
`node_modules` out of Git.
