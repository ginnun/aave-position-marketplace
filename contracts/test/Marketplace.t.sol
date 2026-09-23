// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkBase} from "./ForkBase.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice Epic 3, 4 and 6: listing, escrow guards and atomic purchase.
contract MarketplaceTest is ForkBase {
    uint256 constant COLLATERAL = 2 ether; // 8000 USD at the pinned block
    uint256 constant DEBT = 2_000e6; // 2000 USDT
    uint256 constant PRICE = 5_000e6; // 5000 USDC

    uint256 internal tokenId;

    function setUp() public override {
        super.setUp();
        openAavePosition(seller, COLLATERAL, DEBT);
        tokenId = migrateIn(seller);
        giveToken(AaveSepolia.USDC, buyer, 10_000e6);
        vm.prank(seller);
        manager.approve(address(market), tokenId);
    }

    function _list() internal returns (Marketplace.Listing memory l) {
        l = defaultListing(PRICE);
        vm.prank(seller);
        market.list(tokenId, l);
    }

    // ------------------------------------------------------------------ US-08 listing

    function test_list_movesTokenIntoEscrow() public {
        _list();
        assertEq(manager.ownerOf(tokenId), address(market), "not escrowed");
        assertTrue(manager.isEscrowed(tokenId), "escrow flag");
        assertEq(market.sellerOf(tokenId), seller, "seller not recorded");
        // The seller keeps control of the position while it is listed.
        assertEq(manager.controllerOf(tokenId), seller, "controller changed");
    }

    function test_list_rejectsUnknownPaymentAsset() public {
        Marketplace.Listing memory l = defaultListing(PRICE);
        l.paymentAsset = AaveSepolia.LINK;
        vm.prank(seller);
        vm.expectRevert(Marketplace.PaymentAssetNotAllowed.selector);
        market.list(tokenId, l);
    }

    // ------------------------------------------------------------------ US-15, US-16 escrow guards

    function test_escrow_blocksWithdrawAndBorrow() public {
        _list();
        vm.startPrank(seller);
        vm.expectRevert(PositionManager.Escrowed.selector);
        manager.withdraw(tokenId, AaveSepolia.WETH, 0.1 ether, seller);
        vm.expectRevert(PositionManager.Escrowed.selector);
        manager.borrow(tokenId, AaveSepolia.USDT, 100e6, seller);
        vm.stopPrank();
    }

    function test_escrow_blocksEModeChange() public {
        _list();
        vm.prank(seller);
        vm.expectRevert(PositionManager.Escrowed.selector);
        manager.setEMode(tokenId, 1);

        // Off the market the same seller may change it again. Category 0 is Aave's "no e-mode",
        // which every position accepts.
        vm.startPrank(seller);
        market.cancel(tokenId);
        manager.setEMode(tokenId, 0);
        vm.stopPrank();
        assertEq(pool.getUserEMode(manager.accountOf(tokenId)), 0, "e-mode not settable off market");
    }

    function test_escrow_allowsSupplyAndRepay() public {
        _list();
        uint256 hfBefore = healthFactor(tokenId);

        giveWeth(seller, 1 ether);
        giveToken(AaveSepolia.USDT, seller, 500e6);
        vm.startPrank(seller);
        IERC20(AaveSepolia.WETH).approve(address(manager), 1 ether);
        manager.supply(tokenId, AaveSepolia.WETH, 1 ether);
        IERC20(AaveSepolia.USDT).approve(address(manager), 500e6);
        manager.repay(tokenId, AaveSepolia.USDT, 500e6);
        vm.stopPrank();

        assertGt(healthFactor(tokenId), hfBefore, "position not strengthened");
    }

    function test_escrow_blocksMigrateOut() public {
        _list();
        vm.prank(seller);
        vm.expectRevert(PositionManager.Escrowed.selector);
        manager.migrateOut(tokenId, seller);
    }

    function test_escrow_directTransferReverts() public {
        vm.prank(seller);
        vm.expectRevert(PositionManager.DirectEscrowTransfer.selector);
        manager.transferFrom(seller, address(market), tokenId);
        assertEq(manager.ownerOf(tokenId), seller, "owner changed");
    }

    function test_escrow_directSafeTransferReverts() public {
        vm.prank(seller);
        vm.expectRevert(PositionManager.DirectEscrowTransfer.selector);
        manager.safeTransferFrom(seller, address(market), tokenId);
        assertEq(manager.ownerOf(tokenId), seller, "owner changed");
    }

    function test_escrow_approvedOperatorCannotTransfer() public {
        vm.prank(seller);
        manager.setApprovalForAll(stranger, true);
        vm.startPrank(stranger);
        vm.expectRevert(PositionManager.DirectEscrowTransfer.selector);
        manager.transferFrom(seller, address(market), tokenId);
        assertEq(manager.ownerOf(tokenId), seller, "owner changed");

        // The same operator moves the token anywhere else, so only the destination was refused.
        manager.transferFrom(seller, buyer, tokenId);
        vm.stopPrank();
        assertEq(manager.ownerOf(tokenId), buyer, "operator not authorised");
    }

    function test_strangerCannotManageListedPosition() public {
        _list();
        giveToken(AaveSepolia.USDT, stranger, 10e6);
        vm.startPrank(stranger);
        IERC20(AaveSepolia.USDT).approve(address(manager), 10e6);
        vm.expectRevert(PositionManager.NotController.selector);
        manager.repay(tokenId, AaveSepolia.USDT, 10e6);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ US-11, US-13 exit paths

    function test_cancel_returnsPositionToSeller() public {
        _list();
        vm.prank(seller);
        market.cancel(tokenId);
        assertEq(manager.ownerOf(tokenId), seller, "not returned");
        assertEq(market.sellerOf(tokenId), address(0), "listing not cleared");
    }

    function test_cancel_onlySeller() public {
        _list();
        vm.prank(stranger);
        vm.expectRevert(Marketplace.NotSeller.selector);
        market.cancel(tokenId);
    }

    function test_closeExpired_anyoneCanCallAndSellerGetsItBack() public {
        Marketplace.Listing memory l = _list();
        vm.warp(l.expiry + 1);
        vm.prank(stranger);
        market.closeExpired(tokenId);
        assertEq(manager.ownerOf(tokenId), seller, "not returned to seller");
    }

    function test_buy_rejectedAfterExpiry() public {
        Marketplace.Listing memory l = _list();
        vm.warp(l.expiry + 1);
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(Marketplace.ListingExpired.selector);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ US-22, US-25 purchase

    function test_buy_transfersOwnershipAndPaysSeller() public {
        _list();
        uint256 sellerBefore = IERC20(AaveSepolia.USDC).balanceOf(seller);
        uint256 feeBefore = IERC20(AaveSepolia.USDC).balanceOf(feeSink);
        uint256 buyerBefore = IERC20(AaveSepolia.USDC).balanceOf(buyer);

        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();

        assertEq(manager.ownerOf(tokenId), buyer, "ownership not transferred");
        assertEq(manager.controllerOf(tokenId), buyer, "control not transferred");

        uint256 fee = PRICE * FEE_BPS / 10_000;
        assertEq(
            IERC20(AaveSepolia.USDC).balanceOf(seller) - sellerBefore,
            PRICE - fee,
            "seller paid wrong"
        );
        assertEq(IERC20(AaveSepolia.USDC).balanceOf(feeSink) - feeBefore, fee, "fee wrong");
        assertEq(
            buyerBefore - IERC20(AaveSepolia.USDC).balanceOf(buyer), PRICE, "buyer charged wrong"
        );
        assertEq(IERC20(AaveSepolia.USDC).balanceOf(address(market)), 0, "marketplace kept funds");
    }

    function test_buy_sellerLosesControlImmediately() public {
        _list();
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();

        giveToken(AaveSepolia.USDT, seller, 10e6);
        vm.startPrank(seller);
        IERC20(AaveSepolia.USDT).approve(address(manager), 10e6);
        vm.expectRevert(PositionManager.NotController.selector);
        manager.repay(tokenId, AaveSepolia.USDT, 10e6);
        vm.stopPrank();
    }

    function test_buy_sellerCannotBuyOwnListing() public {
        _list();
        giveToken(AaveSepolia.USDC, seller, PRICE);
        vm.startPrank(seller);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(Marketplace.SelfPurchase.selector);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();
    }

    /// @notice US-26: two buyers race, one wins and the other loses nothing.
    function test_buy_secondBuyerFindsNothing() public {
        _list();
        giveToken(AaveSepolia.USDC, stranger, PRICE);

        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();

        uint256 before = IERC20(AaveSepolia.USDC).balanceOf(stranger);
        vm.startPrank(stranger);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(Marketplace.NotListed.selector);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();
        assertEq(IERC20(AaveSepolia.USDC).balanceOf(stranger), before, "loser lost funds");
    }

    // ------------------------------------------------------------------ US-14 private listing

    function test_privateListing_onlyNamedBuyer() public {
        Marketplace.Listing memory l = defaultListing(PRICE);
        l.allowedBuyer = buyer;
        vm.prank(seller);
        market.list(tokenId, l);

        giveToken(AaveSepolia.USDC, stranger, PRICE);
        vm.startPrank(stranger);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(Marketplace.NotAllowedBuyer.selector);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();

        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();
        assertEq(manager.ownerOf(tokenId), buyer);
    }

    // ------------------------------------------------------------------ US-23 buyer limits

    function test_buy_rejectedWhenPriceAboveMax() public {
        _list();
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(Marketplace.LimitExceeded.selector, Marketplace.Limit.Price)
        );
        market.buy(tokenId, defaultLimits(PRICE - 1));
        vm.stopPrank();
    }

    function test_buy_rejectedWhenHealthFactorBelowMin() public {
        _list();
        Marketplace.BuyLimits memory limits = defaultLimits(PRICE);
        limits.minHealthFactor = healthFactor(tokenId) + 1;
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                Marketplace.LimitExceeded.selector, Marketplace.Limit.HealthFactor
            )
        );
        market.buy(tokenId, limits);
        vm.stopPrank();
        assertEq(manager.ownerOf(tokenId), address(market), "listing did not survive the refusal");
    }

    function test_buy_rejectedWhenDebtAboveMax() public {
        _list();
        Marketplace.BuyLimits memory limits = defaultLimits(PRICE);
        limits.maxDebtBase = 1;
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(Marketplace.LimitExceeded.selector, Marketplace.Limit.Debt)
        );
        market.buy(tokenId, limits);
        vm.stopPrank();
    }

    function test_buy_rejectedAfterOwnDeadline() public {
        _list();
        Marketplace.BuyLimits memory limits = defaultLimits(PRICE);
        limits.deadline = block.timestamp - 1;
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(Marketplace.LimitExceeded.selector, Marketplace.Limit.Deadline)
        );
        market.buy(tokenId, limits);
        vm.stopPrank();
    }

    /// @notice A found issue: the buyer named no payment asset, so a seller could front-run the
    ///         purchase, switch the listing to another token the buyer had approved, and have
    ///         maxPrice compared against a different number of decimals.
    function test_buy_refusesADifferentPaymentAsset() public {
        _list();

        // The seller switches the listing to DAI while the buyer is still expecting USDC.
        Marketplace.Listing memory swapped = defaultListing(PRICE);
        swapped.paymentAsset = AaveSepolia.DAI;
        vm.prank(seller);
        market.updateListing(tokenId, swapped);

        giveToken(AaveSepolia.DAI, buyer, 1_000_000e18);
        vm.startPrank(buyer);
        IERC20(AaveSepolia.DAI).approve(address(market), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                Marketplace.LimitExceeded.selector, Marketplace.Limit.PaymentAsset
            )
        );
        market.buy(tokenId, defaultLimits(PRICE)); // still says USDC
        vm.stopPrank();
    }

    /// @notice A found issue: the sale price came from Aave's collateral total, which leaves out
    ///         reserves it will not lend against. The buyer still receives those balances, so a
    ///         dynamic listing was handing them over for nothing.
    function test_dynamicPrice_countsASupplyThatIsNotCollateral() public {
        replaceFeed(AaveSepolia.WETH, 4000e8);
        replaceFeed(AaveSepolia.LINK, 30e8);

        Marketplace.Listing memory l = defaultListing(0);
        l.rateBps = 10_000; // the whole net value, so the price follows it exactly
        vm.prank(seller);
        market.list(tokenId, l);

        uint256 before = market.currentPrice(tokenId);

        // Add LINK and take it out of the account's collateral, the shape a zero loan to value
        // reserve produces by itself.
        address account = manager.accountOf(tokenId);
        giveToken(AaveSepolia.LINK, seller, 100e18);
        vm.startPrank(seller);
        IERC20(AaveSepolia.LINK).approve(address(manager), 100e18);
        manager.supply(tokenId, AaveSepolia.LINK, 100e18);
        vm.stopPrank();
        vm.prank(account);
        pool.setUserUseReserveAsCollateral(AaveSepolia.LINK, false);

        (uint256 aaveCollateral,,,,,) = pool.getUserAccountData(account);
        assertEq(aaveCollateral, 8_000e8, "Aave should not count the LINK");

        // 100 LINK at 30 USD is 3000 USD, which the price has to pick up.
        uint256 after_ = market.currentPrice(tokenId);
        assertApproxEqRel(after_ - before, 3_000e6, 1e15, "the extra supply was not priced");
    }

    // ------------------------------------------------------------------ US-09 dynamic price

    function test_dynamicPrice_followsNetValue() public {
        MockAggregator feed = replaceFeed(AaveSepolia.WETH, 4000e8);

        Marketplace.Listing memory l = defaultListing(0);
        l.rateBps = 9_000; // 90% of net value, a 10% discount
        vm.prank(seller);
        market.list(tokenId, l);

        uint256 priceBefore = market.currentPrice(tokenId);
        uint256 expected = netValueBase(tokenId) * 9_000 / 10_000 / 100; // base 1e8 -> USDC 1e6
        assertApproxEqRel(priceBefore, expected, 1e12, "price off net value");

        // A 10% price drop lowers the net value and therefore the asking price.
        feed.setAnswer(3600e8);
        uint256 priceAfter = market.currentPrice(tokenId);
        assertLt(priceAfter, priceBefore, "price did not follow the market");
    }

    function test_dynamicPrice_honoursSellerFloor() public {
        replaceFeed(AaveSepolia.WETH, 4000e8);
        Marketplace.Listing memory l = defaultListing(0);
        l.rateBps = 9_000;
        l.minPrice = 100_000e6;
        vm.prank(seller);
        market.list(tokenId, l);
        assertEq(market.currentPrice(tokenId), 100_000e6, "floor ignored");
    }

    /// @notice US-10: below the seller threshold the listing stops being buyable, and recovers.
    function test_healthFactorThreshold_invalidatesAndRecovers() public {
        MockAggregator feed = replaceFeed(AaveSepolia.WETH, 4000e8);
        Marketplace.Listing memory l = defaultListing(PRICE);
        l.minHealthFactor = 2e18;
        vm.prank(seller);
        market.list(tokenId, l);

        feed.setAnswer(1500e8); // health factor drops under the threshold
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        vm.expectRevert(Marketplace.ListingInvalid.selector);
        market.buy(tokenId, defaultLimits(PRICE));
        vm.stopPrank();

        // The seller adds collateral and the listing becomes buyable again.
        giveWeth(seller, 4 ether);
        vm.startPrank(seller);
        IERC20(AaveSepolia.WETH).approve(address(manager), 4 ether);
        manager.supply(tokenId, AaveSepolia.WETH, 4 ether);
        vm.stopPrank();

        vm.prank(buyer);
        market.buy(tokenId, defaultLimits(PRICE));
        assertEq(manager.ownerOf(tokenId), buyer, "sale did not complete");
    }

    // ------------------------------------------------------------------ US-32 resale

    function test_buyerCanRelistAndMigrateOut() public {
        _list();
        vm.startPrank(buyer);
        IERC20(AaveSepolia.USDC).approve(address(market), PRICE);
        market.buy(tokenId, defaultLimits(PRICE));
        manager.approve(address(market), tokenId);
        market.list(tokenId, defaultListing(PRICE));
        market.cancel(tokenId);
        vm.stopPrank();

        delegateForMigrateOut(buyer, tokenId);
        vm.prank(buyer);
        manager.migrateOut(tokenId, buyer);
        (uint256 collateral,,,,,) = pool.getUserAccountData(buyer);
        assertGt(collateral, 0, "buyer did not receive the position");
    }
}
