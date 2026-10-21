<p align="center"><img src="site/img/og.png" alt="townhall" width="720"></p>

# townhall

Your own Farcaster client and Snapchain read node, in three commands. No API keys from anyone.

- **Tutorial:** https://townhallfc.xyz ([中文](https://townhallfc.xyz/zh/))
- **Live demo:** https://app.townhallfc.xyz (the author's node and client, built from this repo)
- **License:** MIT

## Quickstart

```bash
# 0. On your computer: create a Hetzner Cloud server and volume
curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/provision.sh | HCLOUD_TOKEN=your_token bash

# 1. On the server: run a Snapchain read node (official compose file)
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/node.sh | bash'

# 2. On the server: build the client from source and serve it over HTTPS
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/client.sh | bash'
```

On Windows, open PowerShell (not cmd). Step 0 and cleanup have PowerShell versions; steps 1 and 2 work as they are:

```powershell
$env:HCLOUD_TOKEN="your_token"; irm https://raw.githubusercontent.com/townhall-fc/townhall/main/install/provision.ps1 | iex
```

Already have a server (Ubuntu 22.04 or 24.04, 4 vCPU, 16 GB RAM, 1 TB disk or more)? Skip step 0.

Hetzner says the volume limit is reached (common on new accounts)? Step 0 lists the server types with a big local disk and removes the small server it just made; run step 0 again with `SERVER_TYPE=<one of them> VOLUME_GB=0` before `bash`. Cloud servers are billed by the hour, so a few days on a bigger type is a small part of its monthly price.

Done testing? Delete the server and volume so billing stops:

```bash
curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/destroy.sh | HCLOUD_TOKEN=your_token bash
```

Windows: `$env:HCLOUD_TOKEN="your_token"; irm https://raw.githubusercontent.com/townhall-fc/townhall/main/install/destroy.ps1 | iex`

## What to expect

Measured on the demo node (Hetzner `cx43`, 1 TB volume, Snapchain 0.14.3, October 2026):

| | |
|---|---|
| Hands-on time | about 10 minutes |
| Snapshot download and unpack | about 11 hours (about 445 GB compressed) |
| Catching up to the chain | about 10 hours |
| Disk | peak about 800 GB, about 560 GB once synced |
| App key | one gasless `KEY_ADD`, active in about 10 seconds |

## What the client does

- Reads everything from your node: the feed of people you follow, profiles, threads, replies and mentions.
- Posts with its own app key: casts, replies, quotes, likes, recasts, follows, deletes.
- Share: every cast has a link on your own client that opens for anyone, signed in or not (the share sheet on phones).
- Adds that key from your recovery phrase as a gasless `KEY_ADD` (custody-signed EIP-712, no transaction, no ETH). The phrase is used only in the browser and cleared right after. The key can revoke itself from Settings.
- Shows which app signed each cast and lets you include or exclude casts by app.
- **Voters only:** filters the feed to people who hold the Farcaster VOTE NFT on Base.
- **Live:** the whole network as your node receives it, from the node's event log: casts, likes, follows, profile changes, messages pruned by storage limits, with block heights per shard.
- **Inspect:** every cast can show its protocol message (hash, signer, signing app, signature).
- Search by username or FID; follower and following counts read from your node.
- **Replies from mutuals:** replies and mentions from people you follow who follow you back, with a switch for everyone.
- Writes go to your read node, which validates them and relays them to the validators.

## Let other people use it (optional)

```bash
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/signin.sh | bash'
```

Visitors see a feed with no login and choose how to sign in: approve townhall in the Farcaster app (a signed key request, no recovery phrase), or use their own keys. Either way the key is made in the visitor's browser and stays there. The server holds only the key of a separate app account that signs the requests: a new FID it registers for you, or a spare account you already have (`IMPORT=1`, run with `ssh -t`).

Shared casts get a link preview either way: `client.sh` starts the same small service without an app account, so `/c/<fid>/<hash>` shows the author and text in Farcaster, Telegram and other apps that read Open Graph tags.

## Repository

```
install/   provision.sh (0), node.sh (1), client.sh (2), destroy.sh, signin.sh, snapshot-guard.sh;
           provision.ps1 and destroy.ps1 for Windows PowerShell
client/    the web client (TypeScript, Vite, @farcaster/core, viem)
server/    optional sign-in service for hosted use
site/      the tutorial
test/      mock Snapchain node, local chainId 10 chain, end-to-end browser tests
```

Development and tests: see [CONTRIBUTING.md](CONTRIBUTING.md). Security notes and reporting: see [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE). Snapchain itself runs from its official image under its own license.
