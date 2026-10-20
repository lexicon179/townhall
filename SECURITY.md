# Security

## What to know before you run it

- **A recovery phrase controls the whole account.** Treat it like `rm -rf`. Test with a test account. Only paste a phrase into software you run yourself or from developers you trust, and prefer delegated sign-in (the optional `signin.sh` mode) when you can.
- **The phrase stays in your browser.** The client derives your custody address, signs the two EIP-712 authorizations for one `KEY_ADD`, and clears it. It is never sent to the server. You can check this in `client/src/keys.ts`.
- **The app key lives in the browser's local storage.** Its scopes allow casts, reactions, follows and profile data; it cannot move your FID or add keys. Settings → Revoke sends a `KEY_REMOVE` signed by the key itself. An unused key also expires on its own (90-day sliding TTL).
- **Your node's `/v1` API is public** through your client address. It serves public network data, and writes still need valid signatures.
- **The hosted sign-in service** (`server/`, optional) keeps one private key on the server, for a separate app account that only signs key requests. It holds no user keys or funds.
- **Your Hetzner token** is used by `provision.sh` and `destroy.sh` on your computer only. It is never sent to the server. Delete it in the Hetzner console when you are done.

## Reporting a problem

Please report security issues privately through GitHub: **Security → Report a vulnerability** on this repository. Do not include recovery phrases, tokens or private keys in any report.
