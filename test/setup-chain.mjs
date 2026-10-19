// Deploys MockFc code at the real IdRegistry + KeyGateway addresses on the local chainId-10 node,
// and gives the hardhat test mnemonic's account #0 FID 4242.
import solc from 'solc';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ID_REGISTRY_ADDRESS, KEY_GATEWAY_ADDRESS } from '@farcaster/core';
const RPC = 'http://127.0.0.1:8546';
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'M.sol': { content: readFileSync(new URL('./MockFc.sol', import.meta.url), 'utf8') } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } } })));
const c = out.contracts['M.sol'].MockFc;
const code = '0x' + c.evm.deployedBytecode.object;
const rpc = (method, params) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
await rpc('hardhat_setCode', [ID_REGISTRY_ADDRESS, code]);
await rpc('hardhat_setCode', [KEY_GATEWAY_ADDRESS, code]);
const chain = { id: 10, name: 'op-local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const w = createWalletClient({ account: owner, chain, transport: http(RPC) });
const p = createPublicClient({ chain, transport: http(RPC) });
const h = await w.writeContract({ address: ID_REGISTRY_ADDRESS, abi: c.abi, functionName: 'setId', args: [owner.address, 4242n] });
await p.waitForTransactionReceipt({ hash: h });
console.log('custody', owner.address, 'fid', await p.readContract({ address: ID_REGISTRY_ADDRESS, abi: c.abi, functionName: 'idOf', args: [owner.address] }));
