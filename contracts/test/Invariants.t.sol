// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkBase} from "./ForkBase.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IScaledBalanceToken} from "aave-v3-origin/contracts/interfaces/IScaledBalanceToken.sol";
import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice Drives random but valid marketplace activity and records what happened.
contract MarketHandler is ForkBase {
    uint256[] public tokens;
    mapping(uint256 => address) public tokenOwner;

    // Ghost accounting used by the invariants.
    uint256 public totalPaidByBuyers;
    uint256 public totalReceivedBySellers;
    uint256 public totalFees;
    uint256 public sales;
    /// @dev One listing is a token plus the round it was listed in. Counting by round
    ///      alone would put two different tokens in the same bucket.
    mapping(uint256 tokenId => mapping(uint256 epoch => uint256 sold)) public salesPerListing;
    mapping(uint256 tokenId => uint256 epoch) public listingEpoch;
    mapping(uint256 => uint256) public escrowScaledCollateral;
    mapping(uint256 => uint256) public escrowScaledDebt;

    address[] internal actors;
    MockAggregator internal wethFeed;

    function init() external {
        wethFeed = replaceFeed(AaveSepolia.WETH, 4000e8);
        actors = [seller, buyer, stranger];
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            openAavePosition(a, 2 ether, 1_500e6);
            uint256 id = migrateIn(a);
            tokens.push(id);
            tokenOwner[id] = a;
            giveToken(AaveSepolia.USDC, a, 500_000e6);
            giveToken(AaveSepolia.USDT, a, 5_000e6);
            giveWeth(a, 20 ether);
            vm.startPrank(a);
            IERC20(AaveSepolia.USDC).approve(address(market), type(uint256).max);
            IERC20(AaveSepolia.USDT).approve(address(manager), type(uint256).max);
            IERC20(AaveSepolia.WETH).approve(address(manager), type(uint256).max);
            manager.setApprovalForAll(address(market), true);
            vm.stopPrank();
        }
    }

    function _pick(uint256 seed) internal view returns (uint256 id) {
        return tokens[seed % tokens.length];
    }

    function _scaled(uint256 id) internal view returns (uint256 collateral, uint256 debt) {
        address account = manager.accountOf(id);
        collateral = IScaledBalanceToken(AaveSepolia.A_WETH).scaledBalanceOf(account);
        debt = IScaledBalanceToken(AaveSepolia.V_USDT).scaledBalanceOf(account);
    }

    function list(uint256 seed, uint256 price, uint16 rate) external {
        uint256 id = _pick(seed);
        if (manager.isEscrowed(id)) return;
        address owner = manager.ownerOf(id);
        Marketplace.Listing memory l = defaultListing(bound(price, 1e6, 1_000_000e6));
        l.rateBps = uint16(bound(rate, 0, 2) == 0 ? 0 : bound(rate, 1, market.MAX_RATE_BPS()));
        l.expiry = uint64(block.timestamp + 3 days);
        vm.prank(owner);
        market.list(id, l);

        listingEpoch[id] += 1;
        (uint256 c, uint256 d) = _scaled(id);
        escrowScaledCollateral[id] = c;
        escrowScaledDebt[id] = d;
    }

    function cancel(uint256 seed) external {
        uint256 id = _pick(seed);
        if (!manager.isEscrowed(id)) return;
        vm.prank(market.sellerOf(id));
        market.cancel(id);
    }

    function buy(uint256 seed, uint256 actorSeed) external {
        uint256 id = _pick(seed);
        if (!manager.isEscrowed(id)) return;
        address bidder = actors[actorSeed % actors.length];
        address listingSeller = market.sellerOf(id);
        if (bidder == listingSeller) return;

        uint256 price;
        try market.currentPrice(id) returns (uint256 p) {
            price = p;
        } catch {
            return;
        }
        if (price > IERC20(AaveSepolia.USDC).balanceOf(bidder)) return;

        uint256 sellerBefore = IERC20(AaveSepolia.USDC).balanceOf(listingSeller);
        uint256 feeBefore = IERC20(AaveSepolia.USDC).balanceOf(feeSink);
        uint256 bidderBefore = IERC20(AaveSepolia.USDC).balanceOf(bidder);

        vm.prank(bidder);
        try market.buy(id, defaultLimits(price)) {
            totalPaidByBuyers += bidderBefore - IERC20(AaveSepolia.USDC).balanceOf(bidder);
            totalReceivedBySellers += IERC20(AaveSepolia.USDC).balanceOf(listingSeller)
            - sellerBefore;
            totalFees += IERC20(AaveSepolia.USDC).balanceOf(feeSink) - feeBefore;
            sales += 1;
            salesPerListing[id][listingEpoch[id]] += 1;
        } catch (bytes memory reason) {
            // Swallowing every revert made this handler unfalsifiable: if `buy` started failing
            // for a real reason, no sale would ever be counted and every invariant that depends
            // on sales would pass on an empty set. Only the refusals this handler can legitimately
            // run into are ignored.
            if (!_isExpectedBuyFailure(reason)) buyFailedUnexpectedly = true;
            buyRefusals += 1;
            return;
        }
    }

    /// @dev Reverts that a randomly built purchase may legitimately hit. Anything else is a bug
    ///      and has to bring the run down where it happened.
    function _isExpectedBuyFailure(bytes memory reason) internal pure returns (bool) {
        if (reason.length < 4) return false;
        bytes4 selector;
        // forge-lint: disable-next-line(asm-keccak256)
        assembly {
            selector := mload(add(reason, 0x20))
        }
        if (
            selector == Marketplace.Paused.selector
                || selector == Marketplace.NotListed.selector
                || selector == Marketplace.ListingExpired.selector
                || selector == Marketplace.ListingInvalid.selector
                || selector == Marketplace.SelfPurchase.selector
                || selector == Marketplace.NotAllowedBuyer.selector
                || selector == Marketplace.PaymentAssetNotAllowed.selector
                || selector == Marketplace.NoPrice.selector
                || selector == Marketplace.LimitExceeded.selector
        ) {
            return true;
        }
        return false;
    }

    /// @dev The escrow guard is what `invariant_listedPositionIsNotWeakened` claims to protect,
    ///      but `weaken` steps around listed positions, so nothing ever tried to break it: the
    ///      invariant stayed green even with the guard removed. Try it on purpose instead.
    function weakenListed(uint256 seed, uint256 amount) external {
        uint256 id = _pick(seed);
        if (!manager.isEscrowed(id)) return;
        address controller = manager.controllerOf(id);

        vm.prank(controller);
        try manager.borrow(id, AaveSepolia.USDT, bound(amount, 1e6, 100e6), controller) {
            escrowGuardBroken = true;
            escrowGuardDetail = "a listed position was allowed to borrow";
        } catch {}

        vm.prank(controller);
        try manager.withdraw(id, AaveSepolia.WETH, bound(amount, 0.01 ether, 1 ether), controller) {
            escrowGuardBroken = true;
            escrowGuardDetail = "a listed position was allowed to withdraw";
        } catch {}

        escrowGuardTries += 1;
    }

    function strengthen(uint256 seed, uint256 amount) external {
        uint256 id = _pick(seed);
        address controller = manager.controllerOf(id);
        uint256 value = bound(amount, 0.01 ether, 1 ether);
        if (IERC20(AaveSepolia.WETH).balanceOf(controller) < value) return;
        vm.prank(controller);
        manager.supply(id, AaveSepolia.WETH, value);
    }

    function repayDebt(uint256 seed, uint256 amount) external {
        uint256 id = _pick(seed);
        address controller = manager.controllerOf(id);
        uint256 value = bound(amount, 1e6, 200e6);
        if (IERC20(AaveSepolia.USDT).balanceOf(controller) < value) return;
        vm.prank(controller);
        manager.repay(id, AaveSepolia.USDT, value);
    }

    uint256 public buyRefusals;
    uint256 public escrowGuardTries;
    // Reverting inside a handler proves nothing: the fuzzer counts it as one more reverted call
    // and moves on. A violation has to survive as state that an invariant can read.
    bool public escrowGuardBroken;
    string public escrowGuardDetail;
    bool public buyFailedUnexpectedly;

    function weaken(uint256 seed, uint256 amount) external {
        uint256 id = _pick(seed);
        if (manager.isEscrowed(id)) return; // the escrow guard is checked by the invariant
        vm.prank(manager.ownerOf(id));
        manager.borrow(id, AaveSepolia.USDT, bound(amount, 1e6, 100e6), manager.ownerOf(id));
    }

    function movePrice(uint256 answer) external {
        wethFeed.setAnswer(int256(bound(answer, 2500e8, 6000e8)));
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function salesFor(uint256 tokenId, uint256 epoch) external view returns (uint256) {
        return salesPerListing[tokenId][epoch];
    }

    function marketplace() external view returns (Marketplace) {
        return market;
    }

    function positionManager() external view returns (PositionManager) {
        return manager;
    }

    function feeSinkAddress() external view returns (address) {
        return feeSink;
    }
}

/// @notice Section 5.2 of the brief: properties that must hold after any sequence of actions.
contract InvariantsTest is ForkBase {
    MarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new MarketHandler();
        handler.setUp();
        handler.init();

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = MarketHandler.list.selector;
        selectors[1] = MarketHandler.cancel.selector;
        selectors[2] = MarketHandler.buy.selector;
        selectors[3] = MarketHandler.strengthen.selector;
        selectors[4] = MarketHandler.repayDebt.selector;
        selectors[5] = MarketHandler.weaken.selector;
        selectors[6] = MarketHandler.movePrice.selector;
        // Without this line the handler exists and is never called, which is how the escrow
        // guard went untested in the first place.
        selectors[7] = MarketHandler.weakenListed.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev The escrow guard held every time it was reached.
    function invariant_escrowGuardHolds() public view {
        assertFalse(handler.escrowGuardBroken(), handler.escrowGuardDetail());
    }

    // Non-vacuity is not asserted here: each invariant runs its own campaign, and a campaign
    // whose random sequence never lists anything would fail such a check for the wrong reason.
    // `escrowGuardTries` is public for anyone who wants to look, and the guard was checked the
    // honest way instead: removing `notEscrowed` from `borrow` makes this suite fail.

    /// @dev `buy` only ever failed for reasons a randomly built purchase can legitimately hit.
    function invariant_buyFailsOnlyForKnownReasons() public view {
        assertFalse(handler.buyFailedUnexpectedly(), "buy reverted for an unexpected reason");
    }

    /// @dev Every sale splits the buyer's payment between the seller and the fee sink exactly.
    function invariant_paymentSplitIsExact() public view {
        assertEq(
            handler.totalPaidByBuyers(),
            handler.totalReceivedBySellers() + handler.totalFees(),
            "payment split does not add up"
        );
    }

    /// @dev The platform never holds user funds between transactions.
    function invariant_platformHoldsNothing() public view {
        address[3] memory holders =
            [address(handler.marketplace()), address(handler.positionManager()), address(0)];
        address[3] memory assets = [AaveSepolia.USDC, AaveSepolia.USDT, AaveSepolia.WETH];
        for (uint256 i; i < 2; ++i) {
            for (uint256 j; j < assets.length; ++j) {
                assertEq(IERC20(assets[j]).balanceOf(holders[i]), 0, "stray balance");
            }
            assertEq(holders[i].balance, 0, "stray ether");
        }
    }

    /// @dev A listed position can only be weakened by the market, never by its seller.
    function invariant_listedPositionIsNotWeakened() public view {
        PositionManager m = handler.positionManager();
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokens(i);
            if (!m.isEscrowed(id)) continue;
            address account = m.accountOf(id);
            assertGe(
                IScaledBalanceToken(AaveSepolia.A_WETH).scaledBalanceOf(account),
                handler.escrowScaledCollateral(id),
                "collateral was reduced while listed"
            );
            assertLe(
                IScaledBalanceToken(AaveSepolia.V_USDT).scaledBalanceOf(account),
                handler.escrowScaledDebt(id),
                "debt was increased while listed"
            );
        }
    }

    /// @dev Escrow and listing record are always consistent, so no position can get lost.
    function invariant_escrowMatchesListing() public view {
        PositionManager m = handler.positionManager();
        Marketplace mk = handler.marketplace();
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokens(i);
            bool escrowed = m.ownerOf(id) == address(mk);
            bool listed = mk.sellerOf(id) != address(0);
            assertEq(escrowed, listed, "escrow and listing disagree");
        }
    }

    /// @dev One listing produces at most one sale.
    function invariant_eachListingSellsOnce() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokens(i);
            uint256 rounds = handler.listingEpoch(id);
            for (uint256 epoch = 1; epoch <= rounds; ++epoch) {
                assertLe(handler.salesFor(id, epoch), 1, "listing sold twice");
            }
        }
    }

    function invariant_feeStaysUnderCap() public view {
        Marketplace mk = handler.marketplace();
        assertLe(mk.feeBps(), mk.MAX_FEE_BPS(), "fee above cap");
    }
}
