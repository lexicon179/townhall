# Changelog

## Unreleased

- Windows: PowerShell versions of step 0 and cleanup (`provision.ps1`, `destroy.ps1`); the guide shows Mac/Linux and Windows commands.
- Install scripts name the exact command to install a missing tool (brew, apt or dnf).
- Live view: the network's event log as your node receives it.
- Inspect a cast's protocol message.
- Search by username or FID; follower and following counts; Farcaster-style relative times.
- Share a cast: a link on your own client that opens for anyone (share sheet on phones).
- Quote casts, and quoted casts shown inside the cast that quotes them.
- Hosted sign-in: a choice between the Farcaster app and your own keys; `signin.sh IMPORT=1` uses an existing spare account as the app account.
- Shared cast links `/c/<fid>/<hash>` with link previews (Open Graph), served by the optional service; without it they still open the client.
- Fix: deleted casts (CAST_REMOVE) no longer break the feed.

## 0.1.0 · 2026-10-20

First public version.

- Three commands: `provision.sh` (Hetzner server and volume), `node.sh` (Snapchain read node), `client.sh` (client built from source, HTTPS with Caddy).
- `destroy.sh` deletes the server and volume.
- Snapshot guard: first sync fits on a 1 TB volume (measured peak about 800 GB).
- Client: feed, profiles, threads, replies and mentions read from your node; casts, replies, likes, recasts, follows, deletes; filter casts by the app that signed them; voters only; replies from mutuals; light and dark theme.
- App keys added as gasless `KEY_ADD` from a recovery phrase, revocable from Settings with a self-signed `KEY_REMOVE`.
- Optional hosted mode (`signin.sh`): signed-out feed and Sign in with Farcaster, no recovery phrase.
- Tutorial with measured sync time, disk and cost, and a section on what broke while building it.
