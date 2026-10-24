# Contributing

Bug reports, test reports and pull requests are welcome. If you ran the tutorial, a report of what happened (including what failed) is the most useful thing you can send: open an issue with the **Test report** template.

## Develop without a 1 TB node

The test setup replaces the real node with a small mock that behaves like Snapchain's HTTP API.

```bash
cd client && npm ci && npm run build && cd ..
cd test && npm ci && cd ..

# a local chain with chainId 10 (any Hardhat project with chainId: 10)
npx hardhat node --port 8546
node test/setup-chain.mjs        # test doubles at the IdRegistry / KeyGateway addresses
node test/mock-hub.mjs           # serves client/dist and a Snapchain-compatible /v1 API on :3999
node test/e2e.mjs /tmp/shots     # browser test of the self-hosted flow
```

What the mock checks for real: message hashes and Ed25519 signatures, that the signer is an active key of the FID, key scopes, gasless `KEY_ADD` (custody `KeyAdd` and `SignedKeyRequest` EIP-712 signatures, recovered and matched against the IdRegistry, plus the nonce) and self-signed `KEY_REMOVE`. Like the real node, it returns `CAST_REMOVE` messages in cast lists.

`test/e2e.mjs` covers: recovery phrase, gasless `KEY_ADD`, cast with a mention, follow, like, reply, thread, filtering by app, voters only, replies from mutuals, revoke.

The hosted sign-in flow has its own test. Run the sign-in service against the mock, then the test:

```bash
APP_FILE=/tmp/app.json FC_API=http://127.0.0.1:3999 DEFAULT_FID=100 node server/index.mjs serve
node test/e2e-signin.mjs /tmp/shots
```

Images, video and channels (the service and the mock share a media folder; files in the second argument: `pic.png`, `clip.mp4`, and `fake.png`, which is not an image):

```bash
MEDIA_DIR=/tmp/media APP_FILE=/tmp/none.json FC_API=http://127.0.0.1:3999 NODE_API=http://127.0.0.1:3999 WWW_DIR=client/dist node server/index.mjs serve
MEDIA_DIR=/tmp/media node test/mock-hub.mjs
node test/e2e-media.mjs /tmp/shots /tmp/files
```

`/tmp/app.json` holds `{"privateKey": "0x…", "fid": 777}` for a throwaway key.

## Pull requests

- Keep changes small and say what you tested.
- Scripts in `install/` must stay readable top to bottom: they are part of the tutorial. They are plain Bash so step 0 runs on any Mac or Linux without installing anything, and they must pass `shellcheck install/*.sh` (CI runs it, along with a type check and build of the client).
- No secrets in issues, logs or screenshots: no recovery phrases, Hetzner tokens or private keys.
