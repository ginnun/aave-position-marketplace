// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "aave-v3-origin/contracts/interfaces/IPool.sol";

import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {IFaucet, IWETH} from "../src/config/IFaucet.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Fills a fresh chain with funded accounts and example positions.
/// @dev Accounts come from the standard development mnemonic, so the same addresses appear
///      every time. Account 0 deploys, accounts 1 to 3 own the example positions.
contract Seed is Script {
    string constant MNEMONIC = "test test test test test test test test test test test junk";

    IPool constant POOL = IPool(AaveSepolia.POOL);
    IFaucet constant FAUCET = IFaucet(AaveSepolia.FAUCET);
    uint256 constant FAUCET_STEP_6 = 10_000e6; // the faucet caps one call at 10000 whole units
    uint256 constant FAUCET_STEP_18 = 10_000e18;

    PositionManager manager;
    Marketplace marketplace;

    function run() external {
        string memory file = vm.readFile(
            string.concat(vm.projectRoot(), "/../deploy/", vm.toString(block.chainid), ".json")
        );
        manager = PositionManager(vm.parseJsonAddress(file, ".positionManager"));
        marketplace = Marketplace(vm.parseJsonAddress(file, ".marketplace"));

        uint256 alice = vm.deriveKey(MNEMONIC, 1);
        uint256 bob = vm.deriveKey(MNEMONIC, 2);
        uint256 carol = vm.deriveKey(MNEMONIC, 3);

        _healthyAndListed(alice);
        _nearLiquidation(bob);
        _multiAsset(carol);
        _plainAavePosition(bob); // waiting to be migrated in from the interface

        console2.log("alice", vm.addr(alice));
        console2.log("bob  ", vm.addr(bob));
        console2.log("carol", vm.addr(carol));
    }

    // ------------------------------------------------------------------ scenarios

    /// @dev Alice keeps one healthy position and lists a second one at a fixed price.
    function _healthyAndListed(uint256 pk) internal {
        address who = vm.addr(pk);
        _fundWeth(pk, 8 ether);
        _fundToken(pk, AaveSepolia.USDC, 50_000e6, 6);

        uint256 healthy = _openTradable(pk, 3 ether, 3_000e6);
        uint256 listed = _openTradable(pk, 2 ether, 2_000e6);

        vm.startBroadcast(pk);
        manager.approve(address(marketplace), listed);
        marketplace.list(
            listed,
            Marketplace.Listing({
                seller: address(0),
                paymentAsset: AaveSepolia.USDC,
                allowedBuyer: address(0),
                fixedPrice: 5_500e6,
                minPrice: 0,
                rateBps: 0,
                expiry: uint64(block.timestamp + 14 days),
                minHealthFactor: 1.1e18,
                quickSale: false
            })
        );
        vm.stopBroadcast();

        console2.log("alice healthy position", healthy);
        console2.log("alice listed position ", listed);
        console2.log("  owner", who);
    }

    /// @dev Bob's position sits just above the liquidation threshold and is listed as a quick sale.
    function _nearLiquidation(uint256 pk) internal {
        _fundWeth(pk, 4 ether);
        _fundToken(pk, AaveSepolia.USDC, 50_000e6, 6);

        // 1 WETH at 4000 USD with 80% loan to value: borrowing 3100 USDT leaves a thin buffer.
        uint256 risky = _openTradable(pk, 1 ether, 3_100e6);

        vm.startBroadcast(pk);
        manager.approve(address(marketplace), risky);
        marketplace.list(
            risky,
            Marketplace.Listing({
                seller: address(0),
                paymentAsset: AaveSepolia.USDC,
                allowedBuyer: address(0),
                fixedPrice: 0,
                minPrice: 100e6,
                rateBps: 8_000, // 20% under net value
                expiry: uint64(block.timestamp + 3 days),
                minHealthFactor: 1.01e18,
                quickSale: true
            })
        );
        vm.stopBroadcast();
        console2.log("bob quick sale position", risky);
    }

    /// @dev Carol holds collateral and debt in more than one asset.
    function _multiAsset(uint256 pk) internal {
        _fundWeth(pk, 3 ether);
        _fundToken(pk, AaveSepolia.LINK, 200e18, 18);
        _fundToken(pk, AaveSepolia.USDC, 20_000e6, 6);

        vm.startBroadcast(pk);
        (uint256 tokenId, address account) = manager.createPosition();
        IERC20(AaveSepolia.WETH).approve(address(manager), type(uint256).max);
        IERC20(AaveSepolia.LINK).approve(address(manager), type(uint256).max);
        manager.supply(tokenId, AaveSepolia.WETH, 2 ether);
        manager.supply(tokenId, AaveSepolia.LINK, 100e18);
        manager.borrow(tokenId, AaveSepolia.USDT, 2_000e6, vm.addr(pk));
        manager.borrow(tokenId, AaveSepolia.DAI, 1_000e18, vm.addr(pk));
        vm.stopBroadcast();

        console2.log("carol multi asset position", tokenId, account);
    }

    /// @dev A plain Aave position, so the interface can demonstrate carrying one in.
    function _plainAavePosition(uint256 pk) internal {
        _fundWeth(pk, 2 ether);
        vm.startBroadcast(pk);
        IERC20(AaveSepolia.WETH).approve(address(POOL), 2 ether);
        POOL.supply(AaveSepolia.WETH, 2 ether, vm.addr(pk), 0);
        POOL.borrow(AaveSepolia.USDT, 1_500e6, 2, 0, vm.addr(pk));
        vm.stopBroadcast();
        console2.log("bob plain aave position ready to migrate");
    }

    // ------------------------------------------------------------------ helpers

    function _openTradable(uint256 pk, uint256 collateral, uint256 debt)
        internal
        returns (uint256 tokenId)
    {
        address who = vm.addr(pk);
        vm.startBroadcast(pk);
        (tokenId,) = manager.createPosition();
        IERC20(AaveSepolia.WETH).approve(address(manager), collateral);
        manager.supply(tokenId, AaveSepolia.WETH, collateral);
        if (debt != 0) manager.borrow(tokenId, AaveSepolia.USDT, debt, who);
        vm.stopBroadcast();
    }

    function _fundWeth(uint256 pk, uint256 amount) internal {
        vm.startBroadcast(pk);
        IWETH(AaveSepolia.WETH).deposit{value: amount}();
        vm.stopBroadcast();
    }

    /// @dev The faucet caps a single call, so larger amounts are minted in steps.
    function _fundToken(uint256 pk, address token, uint256 amount, uint8 decimals) internal {
        uint256 step = decimals == 6 ? FAUCET_STEP_6 : FAUCET_STEP_18;
        address who = vm.addr(pk);
        vm.startBroadcast(pk);
        uint256 left = amount;
        while (left > 0) {
            uint256 chunk = left > step ? step : left;
            FAUCET.mint(token, who, chunk);
            left -= chunk;
        }
        vm.stopBroadcast();
    }
}
