// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkBase} from "./ForkBase.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice Epic 9 plus the trust limits from US-17: what the admin can and cannot do.
contract AdminTest is ForkBase {
    uint256 constant COLLATERAL = 2 ether;
    uint256 constant DEBT = 2_000e6;
    uint256 constant PRICE = 5_000e6;

    uint256 internal tokenId;

    function setUp() public override {
        super.setUp();
        openAavePosition(seller, COLLATERAL, DEBT);
        tokenId = migrateIn(seller);
        giveToken(AaveSepolia.USDC, buyer, 10_000e6);
        vm.startPrank(seller);
        manager.approve(address(market), tokenId);
        market.list(tokenId, defaultListing(PRICE));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ US-33 fees

    function test_feeCannotExceedHardCap() public {
        uint256 cap = market.MAX_FEE_BPS();
        vm.prank(admin);
        market.setFee(cap, feeSink);
        assertEq(market.feeBps(), cap);

        vm.prank(admin);
        vm.expectRevert(Marketplace.FeeTooHigh.selector);
        market.setFee(cap + 1, feeSink);
    }

    function test_onlyOwnerChangesFee() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        market.setFee(10, stranger);
    }

    // ------------------------------------------------------------------ US-17 admin cannot take assets

    function test_adminCannotMovePositionOrFunds() public {
        // The marketplace holds the token, but nothing lets the admin redirect it.
        assertEq(manager.ownerOf(tokenId), address(market));

        vm.startPrank(admin);
        vm.expectRevert(); // the marketplace is not approved for the admin
        manager.transferFrom(address(market), admin, tokenId);
        vm.stopPrank();

        // The manager exposes no admin role at all.
        vm.prank(admin);
        vm.expectRevert(Marketplace.NotSeller.selector);
        market.cancel(tokenId);
    }

    // ------------------------------------------------------------------ US-34 emergency stop

    function test_pause_stopsBuyingButNotCancelling() public {
        vm.prank(admin);
        market.setPaused(true);

        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(Marketplace.Paused.selector);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();

        // Escape hatches keep working while paused.
        vm.prank(seller);
        market.cancel(tokenId);
        assertEq(manager.ownerOf(tokenId), seller, "seller could not exit while paused");
    }

    function test_pause_stopsNewListings() public {
        vm.prank(seller);
        market.cancel(tokenId);
        vm.prank(admin);
        market.setPaused(true);

        vm.startPrank(seller);
        manager.approve(address(market), tokenId);
        vm.expectRevert(Marketplace.Paused.selector);
        market.list(tokenId, defaultListing(PRICE));
        vm.stopPrank();
    }

    function test_pause_stillAllowsMigrateOutAfterCancel() public {
        vm.prank(admin);
        market.setPaused(true);
        vm.prank(seller);
        market.cancel(tokenId);

        delegateForMigrateOut(seller, tokenId);
        vm.prank(seller);
        manager.migrateOut(tokenId, seller);
        (uint256 collateral,,,,,) = pool.getUserAccountData(seller);
        assertGt(collateral, 0, "migrate out blocked while paused");
    }

    // ------------------------------------------------------------------ liquidation while listed

    /// @notice Mandatory scenario 4: a listed position is liquidated, the buyer is protected.
    function test_liquidationWhileListed_buyerProtected() public {
        MockAggregator feed = replaceFeed(AaveSepolia.WETH, 4000e8);
        uint256 netBefore = netValueBase(tokenId);

        feed.setAnswer(1200e8); // health factor falls below 1
        address account = manager.accountOf(tokenId);
        (,,,,, uint256 hf) = pool.getUserAccountData(account);
        assertLt(hf, 1e18, "position should be liquidatable");

        // A liquidator takes part of the collateral. This is Aave behaviour we cannot block.
        address liquidator = makeAddr("liquidator");
        giveToken(AaveSepolia.USDT, liquidator, 1_000e6);
        vm.startPrank(liquidator);
        IERC20(AaveSepolia.USDT).approve(address(pool), 1_000e6);
        pool.liquidationCall(AaveSepolia.WETH, AaveSepolia.USDT, account, 1_000e6, false);
        vm.stopPrank();

        uint256 netAfter = netValueBase(tokenId);
        assertLt(netAfter, netBefore, "net value should have dropped");

        // The buyer set a floor on net value, so the purchase is refused.
        Marketplace.BuyLimits memory limits = defaultLimits(PRICE);
        limits.minNetValueBase = netBefore;
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(Marketplace.LimitExceeded.selector, Marketplace.Limit.NetValue)
        );
        market.buy(tokenId, limits);
        vm.stopPrank();
    }
}
