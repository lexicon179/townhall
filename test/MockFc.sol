// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Test double placed at the IdRegistry and KeyGateway addresses on a local chain with chainId 10.
contract MockFc {
    mapping(address => uint256) public idOf;
    event Add(address indexed custody, uint32 keyType, bytes key, uint8 metadataType, bytes metadata);
    function setId(address a, uint256 fid) external { idOf[a] = fid; }
    function add(uint32 keyType, bytes calldata key, uint8 metadataType, bytes calldata metadata) external {
        emit Add(msg.sender, keyType, key, metadataType, metadata);
    }
}
