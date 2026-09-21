// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IAaveOracle} from "aave-v3-origin/contracts/interfaces/IAaveOracle.sol";

import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice Local chain only: replaces the Aave price feeds with feeds this project can move.
/// @dev Run it with `--unlocked --sender <ACL_ADMIN>` against an anvil fork that impersonates
///      accounts. The public testnet keeps its own fixed feeds, so prices there never change.
contract LocalSetup is Script {
    function run() external {
        require(block.chainid != AaveSepolia.CHAIN_ID, "refusing to touch the public testnet");

        address[] memory assets = new address[](4);
        address[] memory sources = new address[](4);
        assets[0] = AaveSepolia.WETH;
        assets[1] = AaveSepolia.LINK;
        assets[2] = AaveSepolia.WBTC;
        assets[3] = AaveSepolia.USDT;

        vm.startBroadcast();
        sources[0] = address(new MockAggregator(4000e8, 8));
        sources[1] = address(new MockAggregator(30e8, 8));
        sources[2] = address(new MockAggregator(60_000e8, 8));
        sources[3] = address(new MockAggregator(1e8, 8));
        IAaveOracle(AaveSepolia.ORACLE).setAssetSources(assets, sources);
        vm.stopBroadcast();

        string memory key = "feeds";
        vm.serializeAddress(key, "WETH", sources[0]);
        vm.serializeAddress(key, "LINK", sources[1]);
        vm.serializeAddress(key, "WBTC", sources[2]);
        string memory json = vm.serializeAddress(key, "USDT", sources[3]);
        vm.writeJson(
            json,
            string.concat(
                vm.projectRoot(), "/../deploy/", vm.toString(block.chainid), ".feeds.json"
            )
        );

        console2.log("WETH feed", sources[0]);
    }
}
