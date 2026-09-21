// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {AaveSepolia} from "../src/config/AaveSepolia.sol";

/// @notice Local chain only: moves one asset price so tests can watch health factors react.
/// @dev Reads the feed address written by LocalSetup. Set SYMBOL and PRICE_USD before running.
contract SetPrice is Script {
    function run() external {
        require(block.chainid != AaveSepolia.CHAIN_ID, "refusing to touch the public testnet");

        string memory symbol = vm.envString("SYMBOL");
        uint256 priceUsd = vm.envUint("PRICE_USD"); // whole dollars

        string memory file = vm.readFile(
            string.concat(
                vm.projectRoot(), "/../deploy/", vm.toString(block.chainid), ".feeds.json"
            )
        );
        address feed = vm.parseJsonAddress(file, string.concat(".", symbol));

        vm.broadcast();
        MockAggregator(feed).setAnswer(int256(priceUsd * 1e8));

        console2.log("price set", symbol, priceUsd);
    }
}
