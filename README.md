# townhall

Your own Farcaster client and Snapchain read node, in three commands. No API keys.

**Tutorial:** https://lexicon179.github.io/townhall (the `site/` folder) explains every step and the protocol concepts behind it.

## Quickstart

```bash
# 0. on your computer: a Hetzner Cloud server with a 2 TB volume
curl -fsSL https://raw.githubusercontent.com/lexicon179/townhall/main/install/provision.sh | HCLOUD_TOKEN=your_token bash

# 1. on the server: Snapchain read node (official compose file, unchanged)
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/lexicon179/townhall/main/install/node.sh | bash'

# 2. on the server: build the client from source and serve it over HTTPS
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/lexicon179/townhall/main/install/client.sh | bash'
```

Have your own server (Ubuntu, 4 vCPU, 16 GB RAM, 2 TB disk)? Skip step 0.

## What the client does

- Reads everything from your node: feed of people you follow, profiles, threads, mentions.
- Posts with its own app key: casts, replies, likes, recasts, follows, deletes.
- Adds that key with your recovery phrase via one `KeyGateway.add` transaction on Optimism. The phrase is used only in the browser and cleared right after.
- Shows which app signed every cast (from the key's `requestFid`) and lets you include or exclude casts by app.
- Submits writes to your read node, which validates and relays them to validators over gossip.

## Let other people use it (optional)

```bash
curl -fsSL https://raw.githubusercontent.com/lexicon179/townhall/main/install/signin.sh | bash
```

Turns your townhall into one anyone can open. Visitors see a feed right away, with no login, and sign in by approving townhall in the Farcaster app (a signed key request). No recovery phrase. The key townhall posts with is made in the visitor's browser and stays there. The server only holds the key of a separate app account that signs the requests. The first run prints that account's address. Send it a little ETH on Optimism to register its FID, then run the command again.

## Layout

```
install/   provision.sh (step 0), node.sh (step 1), client.sh (step 2)
client/    the web client (TypeScript, Vite, @farcaster/core, viem)
site/      the tutorial microsite
test/      a mock Snapchain node + local chainId 10 chain for end-to-end tests
```

## Develop and test without a 2 TB node

```bash
cd client && npm ci && npm run build && cd ..
# local chain with chainId 10, then put test doubles at the IdRegistry/KeyGateway addresses
npx hardhat node --port 8546   # any hardhat project with chainId: 10
node test/setup-chain.mjs
node test/mock-hub.mjs          # serves client/dist and a Snapchain-compatible /v1 API on :3999
```

The mock node validates submitted messages for real (hash, Ed25519 signature, active signer) and reads app keys from KeyGateway events, verifying the SignedKeyRequest EIP-712 signature the way the onchain validator does. `test/e2e.mjs` drives the whole flow in a browser: recovery phrase, app key transaction, cast with mention, follow, like, reply, thread, client filter. `test/e2e-signin.mjs` covers the hosted mode: signed-out feed, Sign in with Farcaster (the mock plays the Farcaster API and checks the app's EIP-712 signature), then a cast with the approved key. Run it with `server/index.mjs serve` pointed at the mock (`FC_API=http://127.0.0.1:3999`).

## Security

- Paste a recovery phrase only into a client you run yourself.
- The app key is stored in the browser. Revoke it with `KeyRegistry.remove` from your custody address.
- Your node's `/v1` API is reachable through your client address. That is public data, and writes still need valid signatures.

MIT licensed.
