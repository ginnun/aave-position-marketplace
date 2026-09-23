// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IPool} from "aave-v3-origin/contracts/interfaces/IPool.sol";
import {
    IPoolAddressesProvider
} from "aave-v3-origin/contracts/interfaces/IPoolAddressesProvider.sol";

import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Deploys the platform on top of an existing Aave V3 market.
/// @dev Re-running it deploys a fresh set and overwrites the address file for that chain.
contract Deploy is Script {
    function run() external {
        uint256 feeBps = vm.envOr("PLATFORM_FEE_BPS", uint256(50));
        // Reading the key here instead of taking --private-key keeps it off the command line,
        // where every user on the machine can read it out of /proc. The name is deliberately
        // not DEPLOYER_PRIVATE_KEY: that one is exported for every script from .env, and a
        // local deploy must not silently start using a funded testnet key.
        uint256 deployerKey = vm.envOr("DEPLOY_PK", uint256(0));
        address deployer = deployerKey == 0 ? msg.sender : vm.addr(deployerKey);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);

        if (deployerKey == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(deployerKey);
        }

        PositionManager manager = new PositionManager(
            IPool(AaveSepolia.POOL), IPoolAddressesProvider(AaveSepolia.POOL_ADDRESSES_PROVIDER)
        );
        Marketplace marketplace = new Marketplace(manager, feeBps, feeRecipient, deployer);
        manager.setEscrow(marketplace);

        marketplace.setPaymentAsset(AaveSepolia.USDC, true);
        marketplace.setPaymentAsset(AaveSepolia.DAI, true);
        marketplace.setPaymentAsset(AaveSepolia.USDT, true);

        vm.stopBroadcast();

        _write(
            address(manager),
            manager.ACCOUNT_IMPL(),
            address(marketplace),
            feeRecipient,
            deployer,
            feeBps
        );

        console2.log("PositionManager", address(manager));
        console2.log("Marketplace    ", address(marketplace));
        console2.log("chainId        ", block.chainid);
    }

    function _write(
        address manager,
        address accountImpl,
        address marketplace,
        address feeRecipient,
        address admin,
        uint256 feeBps
    ) internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deployBlock", block.number);
        vm.serializeUint(key, "feeBps", feeBps);
        vm.serializeAddress(key, "positionManager", manager);
        vm.serializeAddress(key, "accountImpl", accountImpl);
        vm.serializeAddress(key, "marketplace", marketplace);
        vm.serializeAddress(key, "feeRecipient", feeRecipient);
        vm.serializeAddress(key, "admin", admin);
        vm.serializeAddress(key, "pool", AaveSepolia.POOL);
        vm.serializeAddress(key, "poolAddressesProvider", AaveSepolia.POOL_ADDRESSES_PROVIDER);
        vm.serializeAddress(key, "oracle", AaveSepolia.ORACLE);
        vm.serializeAddress(key, "dataProvider", AaveSepolia.DATA_PROVIDER);
        string memory json = vm.serializeAddress(key, "faucet", AaveSepolia.FAUCET);

        string memory path =
            string.concat(vm.projectRoot(), "/../deploy/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("addresses written to", path);
    }
}
