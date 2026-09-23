// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkBase} from "./ForkBase.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    ICreditDelegationToken
} from "aave-v3-origin/contracts/interfaces/ICreditDelegationToken.sol";
import {
    IPoolAddressesProvider
} from "aave-v3-origin/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPoolConfigurator} from "aave-v3-origin/contracts/interfaces/IPoolConfigurator.sol";
import {IACLManager} from "aave-v3-origin/contracts/interfaces/IACLManager.sol";
import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {DataTypes} from "aave-v3-origin/contracts/protocol/libraries/types/DataTypes.sol";

/// @notice US-03 and US-06: carrying a live Aave position in and out in one transaction.
contract MigrationTest is ForkBase {
    uint256 constant COLLATERAL = 2 ether; // 2 WETH, 8000 USD at the pinned block
    uint256 constant DEBT = 2_000e6; // 2000 USDT

    /// @dev The Aave token reserve on Sepolia. It is the only reserve nobody owes anything on at
    ///      the pinned block, which is what a siloed borrowing test needs, and it is not part of
    ///      the addresses the product itself uses, so it stays out of AaveSepolia.
    address constant AAVE_TOKEN = 0x88541670E55cC00bEEFD87eB59EDd1b7C511AC9a;

    function test_migrateIn_carriesCollateralAndDebt() public {
        openAavePosition(seller, COLLATERAL, DEBT);

        (uint256 beforeCollateral, uint256 beforeDebt,,,,) = pool.getUserAccountData(seller);
        assertGt(beforeCollateral, 0, "no collateral before");
        assertGt(beforeDebt, 0, "no debt before");

        uint256 tokenId = migrateIn(seller);
        address account = manager.accountOf(tokenId);

        assertEq(manager.ownerOf(tokenId), seller, "token not minted to seller");

        (uint256 afterCollateral, uint256 afterDebt,,,, uint256 hf) =
            pool.getUserAccountData(account);
        assertApproxEqRel(afterCollateral, beforeCollateral, 1e12, "collateral not carried over");
        assertApproxEqRel(afterDebt, beforeDebt, 1e12, "debt not carried over");
        assertGt(hf, 1e18, "position unhealthy after migration");

        // The seller's own Aave position is empty again.
        (uint256 leftCollateral, uint256 leftDebt,,,,) = pool.getUserAccountData(seller);
        assertEq(leftCollateral, 0, "collateral left behind");
        assertEq(leftDebt, 0, "debt left behind");

        // No credit delegation is left over for the manager.
        assertEq(
            ICreditDelegationToken(AaveSepolia.V_USDT).borrowAllowance(account, address(manager)),
            0,
            "delegation not cleared"
        );
    }

    function test_migrateOut_returnsPositionToOwner() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        uint256 tokenId = migrateIn(seller);

        (uint256 collateralBefore, uint256 debtBefore,,,,) =
            pool.getUserAccountData(manager.accountOf(tokenId));

        delegateForMigrateOut(seller, tokenId);
        vm.prank(seller);
        manager.migrateOut(tokenId, seller);

        (uint256 collateralAfter, uint256 debtAfter,,,, uint256 hf) =
            pool.getUserAccountData(seller);
        assertApproxEqRel(collateralAfter, collateralBefore, 1e12, "collateral lost");
        assertApproxEqRel(debtAfter, debtBefore, 1e12, "debt lost");
        assertGt(hf, 1e18, "unhealthy after migrate out");

        vm.expectRevert();
        manager.ownerOf(tokenId);
    }

    function test_migrateIn_withoutDebt() public {
        openAavePosition(seller, COLLATERAL, 0);
        uint256 tokenId = migrateIn(seller);
        (uint256 collateral, uint256 debt,,,,) = manager.accountData(tokenId);
        assertGt(collateral, 0, "no collateral");
        assertEq(debt, 0, "unexpected debt");
    }

    function test_migrateIn_refusesEmptyPosition() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionManager.MigrationBlocked.selector, PositionManager.Blocker.NoCollateral
            )
        );
        manager.migrateIn();
    }

    /// @notice A found issue: owning the source token said nothing about the right to borrow
    ///         against someone else, so anyone who had granted a delegation for their own
    ///         migration could have had an unwanted position pushed onto them.
    function test_migrateOut_refusesAThirdPartyRecipient() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        uint256 tokenId = migrateIn(seller);
        delegateForMigrateOut(buyer, tokenId);

        vm.prank(seller);
        vm.expectRevert(PositionManager.NotRecipient.selector);
        manager.migrateOut(tokenId, buyer);
    }

    /// @notice A found issue: a supplied balance that Aave did not flag as collateral was left
    ///         behind, and the ownership token was burned anyway, so it could never be reached.
    function test_migrateOut_carriesASupplyThatIsNotCollateral() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        uint256 tokenId = migrateIn(seller);
        address account = manager.accountOf(tokenId);

        giveToken(AaveSepolia.LINK, seller, 5e18);
        vm.startPrank(seller);
        IERC20(AaveSepolia.LINK).approve(address(manager), 5e18);
        manager.supply(tokenId, AaveSepolia.LINK, 5e18);
        vm.stopPrank();

        // Aave enables collateral on a first supply. Turn it off to reach the state that a zero
        // loan to value or isolated reserve produces on its own.
        vm.prank(account);
        pool.setUserUseReserveAsCollateral(AaveSepolia.LINK, false);
        assertGt(IERC20(AaveSepolia.A_LINK).balanceOf(account), 0, "no aLINK to begin with");

        (address[] memory aTokens,,,) = manager.scan(account);
        bool listed;
        for (uint256 i; i < aTokens.length; ++i) {
            if (aTokens[i] == AaveSepolia.A_LINK) listed = true;
        }
        assertTrue(listed, "scan dropped a balance that is not collateral");

        delegateForMigrateOut(seller, tokenId);
        vm.prank(seller);
        manager.migrateOut(tokenId, seller);

        assertEq(
            IERC20(AaveSepolia.A_LINK).balanceOf(account), 0, "balance stranded in the account"
        );
        assertGt(IERC20(AaveSepolia.A_LINK).balanceOf(seller), 0, "balance never reached the owner");
    }

    /// @notice A found issue: a health factor above 1 was treated as migratable, but Aave reopens
    ///         the debt through its borrow path, which uses the stricter loan to value line. A
    ///         position between the two lines was offered as migratable and then reverted.
    function test_migrateIn_refusesDebtAboveTheBorrowingLimit() public {
        MockAggregator feed = replaceFeed(AaveSepolia.WETH, 4000e8);

        // 1 WETH at 4000 USD allows 3200 of debt at 80% loan to value.
        openAavePosition(seller, 1 ether, 3_150e6);

        // A small fall puts the position between the two lines: still above a health factor of
        // 1, already above what the collateral may borrow against.
        feed.setAnswer(3900e8);
        (uint256 collateral, uint256 debt,,,, uint256 hf) = pool.getUserAccountData(seller);
        assertGt(hf, 1e18, "should not be liquidatable yet");
        assertLt((collateral * 8000) / 10_000, debt, "should already be above the borrowing limit");

        assertEq(
            uint256(manager.migrationBlocker(seller)),
            uint256(PositionManager.Blocker.DebtAboveLtv),
            "preflight did not name the reason"
        );

        (address[] memory aTokens,,,) = manager.scan(seller);
        vm.startPrank(seller);
        for (uint256 i; i < aTokens.length; ++i) {
            IERC20(aTokens[i]).approve(address(manager), type(uint256).max);
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionManager.MigrationBlocked.selector, PositionManager.Blocker.DebtAboveLtv
            )
        );
        manager.migrateIn();
        vm.stopPrank();
    }

    /// @notice A found issue: Aave turns on collateral for an aToken that lands on an empty
    ///         balance, so a supply the user had left out of their collateral started backing
    ///         debt in the new account, changing the risk instead of carrying it across.
    function test_migrateIn_keepsASupplyOutOfCollateralWhenItStartedThatWay() public {
        openAavePosition(seller, COLLATERAL, DEBT);

        giveToken(AaveSepolia.LINK, seller, 10e18);
        vm.startPrank(seller);
        IERC20(AaveSepolia.LINK).approve(address(pool), 10e18);
        pool.supply(AaveSepolia.LINK, 10e18, seller, 0);
        pool.setUserUseReserveAsCollateral(AaveSepolia.LINK, false);
        vm.stopPrank();

        uint256 tokenId = migrateIn(seller);
        address account = manager.accountOf(tokenId);

        assertGt(IERC20(AaveSepolia.A_LINK).balanceOf(account), 0, "the LINK did not come across");

        DataTypes.ReserveDataLegacy memory rd = pool.getReserveData(AaveSepolia.LINK);
        (, bool usedAsCollateral) = _reserveStatus(account, rd.id);
        assertFalse(usedAsCollateral, "LINK was turned into collateral by the move");
    }

    function _reserveStatus(address user, uint256 id) internal view returns (bool, bool) {
        uint256 data = pool.getUserConfiguration(user).data;
        return ((data >> (id * 2)) & 1 == 1, (data >> (id * 2 + 1)) & 1 == 1);
    }

    // ------------------------------------------------------------------ reserve configuration

    /// @dev Hands this test contract the pool admin role, which covers every configurator setter
    ///      used below, and answers with the configurator to call. Only the ACL admin may grant it.
    function _configurator() internal returns (IPoolConfigurator) {
        IPoolAddressesProvider provider =
            IPoolAddressesProvider(AaveSepolia.POOL_ADDRESSES_PROVIDER);
        IACLManager acl = IACLManager(provider.getACLManager());
        if (!acl.isPoolAdmin(address(this))) {
            vm.prank(AaveSepolia.ACL_ADMIN);
            acl.addPoolAdmin(address(this));
        }
        return IPoolConfigurator(provider.getPoolConfigurator());
    }

    /// @dev Both halves of a refusal: the preflight view names the reason, and migrateIn refuses
    ///      with the same one instead of failing somewhere inside Aave.
    function _assertBlocked(address user, PositionManager.Blocker reason) internal {
        assertEq(
            uint256(manager.migrationBlocker(user)),
            uint256(reason),
            "preflight did not name the reason"
        );

        (address[] memory aTokens,,,) = manager.scan(user);
        vm.startPrank(user);
        for (uint256 i; i < aTokens.length; ++i) {
            IERC20(aTokens[i]).approve(address(manager), type(uint256).max);
        }
        vm.expectRevert(abi.encodeWithSelector(PositionManager.MigrationBlocked.selector, reason));
        manager.migrateIn();
        vm.stopPrank();
    }

    /// @notice A paused reserve refuses every interaction, the aToken transfer included, so a
    ///         position that touches one cannot be carried across.
    function test_migrateIn_refusesAPausedReserve() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        _configurator().setReservePause(AaveSepolia.USDT, true);
        _assertBlocked(seller, PositionManager.Blocker.ReservePaused);
    }

    /// @notice A frozen reserve still repays but takes no new borrow, and the move reopens the
    ///         debt on the new account, so it is refused.
    function test_migrateIn_refusesAFrozenDebtReserve() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        _configurator().setReserveFreeze(AaveSepolia.USDT, true);
        _assertBlocked(seller, PositionManager.Blocker.ReserveFrozen);
    }

    /// @notice A siloed reserve may be the only debt its borrower has, a rule the flash loan leg
    ///         of the move cannot honor, so the move is refused.
    function test_migrateIn_refusesSiloedBorrowing() public {
        // Aave refuses to silo a reserve anyone still owes, and the live market carries USDT
        // debt, so the test borrows the one reserve with no debt behind it and silos it first.
        IPoolConfigurator configurator = _configurator();
        configurator.setReserveBorrowing(AAVE_TOKEN, true);
        configurator.setSiloedBorrowing(AAVE_TOKEN, true);

        openAavePosition(seller, COLLATERAL, 0);
        vm.prank(seller);
        pool.borrow(AAVE_TOKEN, 1e18, 2, 0, seller);

        _assertBlocked(seller, PositionManager.Blocker.SiloedBorrowing);
    }

    /// @notice An isolated asset held on its own puts its owner in isolation mode, where the
    ///         collateral rules of the new account would not match, so the move is refused.
    function test_migrateIn_refusesIsolationMode() public {
        // USDT already carries a debt ceiling on Sepolia, and Aave refuses to put one on a
        // reserve that has suppliers, so the isolated asset is supplied rather than invented.
        // The reserve sits at its supply cap on the live market, so the cap is lifted first.
        _configurator().setSupplyCap(AaveSepolia.USDT, 0);

        giveToken(AaveSepolia.USDT, seller, 1_000e6);
        vm.startPrank(seller);
        IERC20(AaveSepolia.USDT).approve(address(pool), 1_000e6);
        pool.supply(AaveSepolia.USDT, 1_000e6, seller, 0);
        // Aave never turns collateral on by itself for an isolated asset, so the owner says so.
        pool.setUserUseReserveAsCollateral(AaveSepolia.USDT, true);
        vm.stopPrank();

        _assertBlocked(seller, PositionManager.Blocker.IsolationMode);
    }

    /// @notice The debt is reopened by borrowing the same amount on the new account, so a reserve
    ///         that no longer allows borrowing cannot be carried across.
    function test_migrateIn_refusesBorrowingDisabled() public {
        // The debt is LINK rather than USDT: the configurator on Sepolia still refuses to turn
        // borrowing off while the reserve carries the retired stable rate flag, which USDT does.
        openAavePosition(seller, COLLATERAL, 0);
        vm.prank(seller);
        pool.borrow(AaveSepolia.LINK, 10e18, 2, 0, seller);

        _configurator().setReserveBorrowing(AaveSepolia.LINK, false);
        _assertBlocked(seller, PositionManager.Blocker.BorrowingDisabled);
    }

    /// @notice The debt travels inside a flash loan, so a reserve with flash loans turned off
    ///         leaves the move no way across.
    function test_migrateIn_refusesFlashLoanDisabled() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        _configurator().setReserveFlashLoaning(AaveSepolia.USDT, false);
        _assertBlocked(seller, PositionManager.Blocker.FlashLoanDisabled);
    }

    /// @notice Moving out lands the position on the owner's own account, and an e-mode that does
    ///         not match would rewrite the risk of both sides, so it is refused until they agree.
    function test_migrateOut_refusesEModeMismatch() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        uint256 tokenId = migrateIn(seller);
        delegateForMigrateOut(seller, tokenId);

        // The seller's own Aave account is empty after the move in, so switching it costs nothing.
        vm.prank(seller);
        pool.setUserEMode(1);
        assertEq(pool.getUserEMode(manager.accountOf(tokenId)), 0, "the position moved e-mode too");

        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionManager.MigrationBlocked.selector, PositionManager.Blocker.EModeMismatch
            )
        );
        manager.migrateOut(tokenId, seller);

        // Back in step, the same call goes through.
        vm.prank(seller);
        pool.setUserEMode(0);
        vm.prank(seller);
        manager.migrateOut(tokenId, seller);
        (uint256 collateral, uint256 debt,,,,) = pool.getUserAccountData(seller);
        assertGt(collateral, 0, "collateral never reached the owner");
        assertGt(debt, 0, "debt never reached the owner");
    }

    /// @notice The flash loan callback is only meant to be reachable from inside a migration.
    function test_executeOperation_refusesDirectCall() public {
        address[] memory assets = new address[](0);
        uint256[] memory amounts = new uint256[](0);

        // Wrong sender: the pool is the only caller the callback answers.
        vm.prank(stranger);
        vm.expectRevert(PositionManager.BadCallback.selector);
        manager.executeOperation(assets, amounts, amounts, stranger, bytes(""));

        // Right sender, wrong initiator: the pool relaying someone else's flash loan.
        vm.prank(address(pool));
        vm.expectRevert(PositionManager.BadCallback.selector);
        manager.executeOperation(assets, amounts, amounts, stranger, bytes(""));

        // Right sender and initiator, but no migration is in progress.
        vm.prank(address(pool));
        vm.expectRevert(PositionManager.BadCallback.selector);
        manager.executeOperation(assets, amounts, amounts, address(manager), bytes(""));
    }

    function test_roundTrip_preservesValue() public {
        openAavePosition(seller, COLLATERAL, DEBT);
        (uint256 c0, uint256 d0,,,,) = pool.getUserAccountData(seller);

        uint256 tokenId = migrateIn(seller);
        delegateForMigrateOut(seller, tokenId);
        vm.prank(seller);
        manager.migrateOut(tokenId, seller);

        (uint256 c1, uint256 d1,,,,) = pool.getUserAccountData(seller);
        assertApproxEqRel(c1, c0, 1e12, "collateral drifted");
        assertApproxEqRel(d1, d0, 1e12, "debt drifted");
    }
}
