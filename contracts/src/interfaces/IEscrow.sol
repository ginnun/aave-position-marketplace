// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Read interface the PositionManager uses to learn who listed an escrowed position.
interface IEscrow {
    /// @return The seller that escrowed `tokenId`, or address(0) when it is not listed.
    function sellerOf(uint256 tokenId) external view returns (address);
}
