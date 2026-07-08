# bridge-anonymizers

Cairo anonymizer contracts (Scarb workspace member) that move USDC between the
starknet-privacy pool and Circle CCTP: `outbound_anonymizer` (pool → CCTP) and
`inbound_anonymizer` (CCTP → pool).

Build: `scarb build` · Test: `snforge test` (needs Starknet Foundry; see `../../.tool-versions`).
