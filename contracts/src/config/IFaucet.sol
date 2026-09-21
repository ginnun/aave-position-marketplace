// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Aave testnet faucet. Permissionless on Sepolia, capped at MAX_MINT_AMOUNT whole units.
interface IFaucet {
    function mint(address token, address to, uint256 amount) external returns (uint256);
    function isMintable(address token) external view returns (bool);
    function MAX_MINT_AMOUNT() external view returns (uint256);
}

/// @notice Wrapped ether test token used by the Aave Sepolia market.
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
