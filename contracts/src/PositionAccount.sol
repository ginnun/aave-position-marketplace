// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal clone that holds one Aave position. Aave sees this address as the position owner.
/// @dev All logic lives in PositionManager; this contract only executes calls on its behalf.
contract PositionAccount {
    error NotManager();
    error AlreadyInitialized();
    error ZeroManager();

    address public manager;

    function initialize(address manager_) external {
        if (manager != address(0)) revert AlreadyInitialized();
        if (manager_ == address(0)) revert ZeroManager();
        manager = manager_;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != manager) revert NotManager();
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}
