// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {IFaucet, IWETH} from "../src/config/IFaucet.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Creates one tradable position on the public testnet and lists it.
/// @dev Running it again creates another position; it never edits an existing one.
contract SeedTestnet is Script {
    /// @dev Set SEED_COLLATERAL_WEI to change the size. The default is small on purpose: the
    ///      point is a working example, and testnet ether is not free to come by.
    uint256 constant DEFAULT_COLLATERAL = 0.004 ether;
    /// @dev Borrowed against it. Kept well inside the loan to value line.
    uint256 constant DEBT_PER_ETH = 1_000e6;

    function run() external {
        string memory file =
            string.concat(vm.projectRoot(), "/../deploy/", vm.toString(block.chainid), ".json");
        PositionManager manager =
            PositionManager(vm.parseJsonAddress(vm.readFile(file), ".positionManager"));
        Marketplace marketplace =
            Marketplace(vm.parseJsonAddress(vm.readFile(file), ".marketplace"));
        // Same reason as Deploy.s.sol: the key comes through the environment so it never
        // appears in the process table.
        uint256 seederKey = vm.envOr("DEPLOY_PK", uint256(0));
        address me = seederKey == 0 ? msg.sender : vm.addr(seederKey);

        uint256 collateral = vm.envOr("SEED_COLLATERAL_WEI", DEFAULT_COLLATERAL);
        uint256 debt = (collateral * DEBT_PER_ETH) / 1 ether;

        // Wrapping more ether than the account holds reverts with nothing useful to read.
        require(
            me.balance > collateral,
            "not enough ether to seed: fund the deployer or lower SEED_COLLATERAL_WEI"
        );

        if (seederKey == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(seederKey);
        }

        IWETH(AaveSepolia.WETH).deposit{value: collateral}();
        IFaucet(AaveSepolia.FAUCET).mint(AaveSepolia.USDC, me, 1_000e6);

        (uint256 tokenId,) = manager.createPosition();
        IERC20(AaveSepolia.WETH).approve(address(manager), collateral);
        manager.supply(tokenId, AaveSepolia.WETH, collateral);
        manager.borrow(tokenId, AaveSepolia.USDT, debt, me);

        manager.approve(address(marketplace), tokenId);
        marketplace.list(
            tokenId,
            Marketplace.Listing({
                seller: address(0),
                paymentAsset: AaveSepolia.USDC,
                allowedBuyer: address(0),
                fixedPrice: 0,
                minPrice: 1e6,
                rateBps: 9_000, // 10% under net value
                expiry: uint64(block.timestamp + 30 days),
                minHealthFactor: 1.05e18,
                quickSale: false
            })
        );

        vm.stopBroadcast();

        console2.log("listed position", tokenId);
        console2.log("account", manager.accountOf(tokenId));
    }
}
