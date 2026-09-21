// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAaveOracle} from "aave-v3-origin/contracts/interfaces/IAaveOracle.sol";
import {IPool} from "aave-v3-origin/contracts/interfaces/IPool.sol";
import {
    IPoolAddressesProvider
} from "aave-v3-origin/contracts/interfaces/IPoolAddressesProvider.sol";
import {
    ICreditDelegationToken
} from "aave-v3-origin/contracts/interfaces/ICreditDelegationToken.sol";
import {DataTypes} from "aave-v3-origin/contracts/protocol/libraries/types/DataTypes.sol";
import {
    ReserveConfiguration
} from "aave-v3-origin/contracts/protocol/libraries/configuration/ReserveConfiguration.sol";
import {
    UserConfiguration
} from "aave-v3-origin/contracts/protocol/libraries/configuration/UserConfiguration.sol";

import {PositionAccount} from "./PositionAccount.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";

/// @notice Ownership token and controller for tradable Aave positions.
/// @dev Every position lives in its own PositionAccount clone. Aave sees that clone as the
///      position owner, so ownership moves by transferring the ERC-721 token, with no debt
///      token transfer (which Aave does not allow).
contract PositionManager is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ReserveConfiguration for DataTypes.ReserveConfigurationMap;
    using UserConfiguration for DataTypes.UserConfigurationMap;

    uint256 internal constant VARIABLE_RATE = 2;

    enum Op {
        MigrateIn,
        MigrateOut
    }

    /// @dev Why a position cannot be migrated. `None` means the migration is supported.
    enum Blocker {
        None,
        NoCollateral,
        IsolationMode,
        SiloedBorrowing,
        ReserveInactive,
        ReserveFrozen,
        ReservePaused,
        EModeMismatch,
        DebtAboveLtv,
        CollateralFlagMismatch,
        BorrowingDisabled,
        FlashLoanDisabled
    }

    error NotController();
    error NotOwner();
    error NotRecipient();
    error Escrowed();
    error EscrowAlreadySet();
    error NotEscrowSetter();
    error UnknownPosition();
    error BadCallback();
    error MigrationBlocked(Blocker reason);
    error ZeroAmount();
    error DirectEscrowTransfer();

    event EscrowSet(address indexed escrow);
    event PositionCreated(uint256 indexed tokenId, address indexed account, address indexed owner);
    event MigratedIn(uint256 indexed tokenId, address indexed from);
    event MigratedOut(uint256 indexed tokenId, address indexed to);
    event PositionAction(
        uint256 indexed tokenId, bytes32 indexed action, address asset, uint256 amount
    );

    IPool public immutable POOL;
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    address public immutable ACCOUNT_IMPL;

    IEscrow public escrow;
    address public escrowSetter;

    uint256 public nextTokenId = 1;
    mapping(uint256 tokenId => address account) public accountOf;

    bool private _migrating;

    constructor(IPool pool, IPoolAddressesProvider provider)
        ERC721("Aave Tradable Position", "ATP")
    {
        POOL = pool;
        ADDRESSES_PROVIDER = provider;
        ACCOUNT_IMPL = address(new PositionAccount());
        escrowSetter = msg.sender;
    }

    /// @notice One-shot wiring of the marketplace that is allowed to escrow positions.
    function setEscrow(IEscrow escrow_) external {
        if (msg.sender != escrowSetter) revert NotEscrowSetter();
        if (address(escrow) != address(0)) revert EscrowAlreadySet();
        escrow = escrow_;
        escrowSetter = address(0);
        emit EscrowSet(address(escrow_));
    }

    // ---------------------------------------------------------------- ownership

    /// @dev The marketplace records the listing in the same call that pulls the token in, so a
    ///      token that arrives any other way has no listing behind it: `sellerOf` answers with the
    ///      zero address, `controllerOf` therefore names nobody, and cancelling, relisting and
    ///      migrating all become impossible. The collateral would be stuck for good. Only the
    ///      escrow itself may pull a token into escrow.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address escrowAddress = address(escrow);
        if (escrowAddress != address(0) && to == escrowAddress && auth != escrowAddress) {
            revert DirectEscrowTransfer();
        }
        return super._update(to, tokenId, auth);
    }

    /// @notice True while the ownership token sits in the marketplace escrow.
    function isEscrowed(uint256 tokenId) public view returns (bool) {
        return address(escrow) != address(0) && _ownerOf(tokenId) == address(escrow);
    }

    /// @notice Address allowed to manage the position: the token owner, or the seller while listed.
    function controllerOf(uint256 tokenId) public view returns (address) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert UnknownPosition();
        if (owner == address(escrow)) return escrow.sellerOf(tokenId);
        return owner;
    }

    modifier onlyController(uint256 tokenId) {
        if (msg.sender != controllerOf(tokenId)) revert NotController();
        _;
    }

    /// @dev Weakening actions (withdraw, borrow, e-mode change) are refused while listed.
    modifier notEscrowed(uint256 tokenId) {
        if (isEscrowed(tokenId)) revert Escrowed();
        _;
    }

    // ---------------------------------------------------------------- lifecycle

    function createPosition() external nonReentrant returns (uint256 tokenId, address account) {
        return _createPosition(msg.sender);
    }

    function _createPosition(address owner) internal returns (uint256 tokenId, address account) {
        tokenId = nextTokenId++;
        account = Clones.clone(ACCOUNT_IMPL);
        PositionAccount(account).initialize(address(this));
        accountOf[tokenId] = account;
        _mint(owner, tokenId);
        emit PositionCreated(tokenId, account, owner);
    }

    // ---------------------------------------------------------------- management

    /// @notice Add collateral. Allowed while listed because it strengthens the position.
    function supply(uint256 tokenId, address asset, uint256 amount)
        external
        nonReentrant
        onlyController(tokenId)
    {
        if (amount == 0) revert ZeroAmount();
        address account = _account(tokenId);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(asset).forceApprove(address(POOL), amount);
        POOL.supply(asset, amount, account, 0);
        emit PositionAction(tokenId, "supply", asset, amount);
    }

    /// @notice Repay debt. Allowed while listed because it strengthens the position.
    /// @param amount Pass type(uint256).max to repay the whole debt.
    function repay(uint256 tokenId, address asset, uint256 amount)
        external
        nonReentrant
        onlyController(tokenId)
        returns (uint256 repaid)
    {
        address account = _account(tokenId);
        uint256 owed = _debtOf(account, asset);
        uint256 pull = amount > owed ? owed : amount;
        if (pull == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), pull);
        IERC20(asset).forceApprove(address(POOL), pull);
        repaid = POOL.repay(asset, pull, VARIABLE_RATE, account);
        emit PositionAction(tokenId, "repay", asset, repaid);
    }

    function withdraw(uint256 tokenId, address asset, uint256 amount, address to)
        external
        nonReentrant
        onlyController(tokenId)
        notEscrowed(tokenId)
        returns (uint256 withdrawn)
    {
        address account = _account(tokenId);
        bytes memory ret = PositionAccount(account)
            .execute(address(POOL), abi.encodeCall(IPool.withdraw, (asset, amount, to)));
        withdrawn = abi.decode(ret, (uint256));
        emit PositionAction(tokenId, "withdraw", asset, withdrawn);
    }

    function borrow(uint256 tokenId, address asset, uint256 amount, address to)
        external
        nonReentrant
        onlyController(tokenId)
        notEscrowed(tokenId)
    {
        if (amount == 0) revert ZeroAmount();
        address account = _account(tokenId);
        PositionAccount(account)
            .execute(
                address(POOL),
                abi.encodeCall(IPool.borrow, (asset, amount, VARIABLE_RATE, 0, account))
            );
        PositionAccount(account).execute(asset, abi.encodeCall(IERC20.transfer, (to, amount)));
        emit PositionAction(tokenId, "borrow", asset, amount);
    }

    function setEMode(uint256 tokenId, uint8 categoryId)
        external
        nonReentrant
        onlyController(tokenId)
        notEscrowed(tokenId)
    {
        PositionAccount(_account(tokenId))
            .execute(address(POOL), abi.encodeCall(IPool.setUserEMode, (categoryId)));
        emit PositionAction(tokenId, "emode", address(0), categoryId);
    }

    // ---------------------------------------------------------------- migration

    /// @notice Move the caller's whole Aave position into a fresh tradable position, atomically.
    /// @dev The caller must first approve every aToken of the position to this contract.
    ///      Debt is carried over with a debt-mode flash loan, so nothing is unwound in between.
    function migrateIn() external nonReentrant returns (uint256 tokenId) {
        address user = msg.sender;
        Blocker blocker = migrationBlocker(user);
        if (blocker != Blocker.None) revert MigrationBlocked(blocker);

        (address[] memory aTokens,, address[] memory debtAssets, uint256[] memory debtAmounts) =
            scan(user);

        address account;
        (tokenId, account) = _createPosition(user);

        // casting to 'uint8' is safe because Aave stores e-mode category ids as uint8
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 eMode = uint8(POOL.getUserEMode(user));
        if (eMode != 0) {
            PositionAccount(account)
                .execute(address(POOL), abi.encodeCall(IPool.setUserEMode, (eMode)));
        }

        // Aave enables a reserve as collateral when an aToken lands on an empty balance, so a
        // supply the user had deliberately left out of their collateral would silently start
        // backing debt. The flags are copied before any debt is opened against them, inside the
        // callback for the flash loan path and here when there is no debt to carry.
        if (debtAssets.length == 0) {
            _carryCollateral(user, account, aTokens);
        } else {
            _setDelegation(account, debtAssets, debtAmounts);
            _migrating = true;
            POOL.flashLoan(
                address(this),
                debtAssets,
                debtAmounts,
                _modes(debtAssets.length),
                account,
                abi.encode(Op.MigrateIn, user, account, aTokens),
                0
            );
            _migrating = false;
            _clearDelegation(account, debtAssets);
        }
        emit MigratedIn(tokenId, user);
    }

    /// @notice Move a tradable position back out to the caller's own Aave position.
    /// @dev The caller must first call `approveDelegation(manager, amount)` on every variable debt
    ///      token of the position, so the flash loan debt can land on them.
    /// @dev `to` has to be the caller. Owning the source token says nothing about the right to
    ///      borrow against someone else, and anyone who has granted this contract a delegation
    ///      for their own migration would otherwise be a target for an unwanted debt position.
    function migrateOut(uint256 tokenId, address to) external nonReentrant notEscrowed(tokenId) {
        if (msg.sender != ownerOf(tokenId)) revert NotOwner();
        if (to != msg.sender) revert NotRecipient();
        address account = _account(tokenId);

        // casting to 'uint8' is safe because Aave stores e-mode category ids as uint8
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 accountEMode = uint8(POOL.getUserEMode(account));
        // forge-lint: disable-next-line(unsafe-typecast)
        if (accountEMode != uint8(POOL.getUserEMode(to))) {
            revert MigrationBlocked(Blocker.EModeMismatch);
        }

        (address[] memory aTokens,, address[] memory debtAssets, uint256[] memory debtAmounts) =
            scan(account);

        if (debtAssets.length == 0) {
            _moveCollateral(account, to, aTokens);
        } else {
            _migrating = true;
            POOL.flashLoan(
                address(this),
                debtAssets,
                debtAmounts,
                _modes(debtAssets.length),
                to,
                abi.encode(Op.MigrateOut, to, account, aTokens),
                0
            );
            _migrating = false;
        }

        _burn(tokenId);
        emit MigratedOut(tokenId, to);
    }

    /// @dev Aave flash loan callback. Only reachable from inside migrateIn / migrateOut.
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL) || initiator != address(this) || !_migrating) {
            revert BadCallback();
        }
        (Op op, address user, address account, address[] memory aTokens) =
            abi.decode(params, (Op, address, address, address[]));

        _repayAll(assets, amounts, op == Op.MigrateIn ? user : account);

        if (op == Op.MigrateIn) {
            _carryCollateral(user, account, aTokens);
        } else {
            _moveCollateral(account, user, aTokens);
        }
        return true;
    }

    // ---------------------------------------------------------------- views

    /// @notice Aave state of a position account.
    function accountData(uint256 tokenId)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        return POOL.getUserAccountData(_account(tokenId));
    }

    /// @notice Lists the aTokens and variable debt of any Aave user.
    /// @return aTokens Collateral aToken addresses in use.
    /// @return aBalances Matching aToken balances.
    /// @return debtAssets Underlying assets with variable debt.
    /// @return debtAmounts Matching debt amounts.
    struct ScanBuf {
        address[] aTokens;
        uint256[] aBalances;
        address[] debtAssets;
        uint256[] debtAmounts;
        uint256 nc;
        uint256 nd;
    }

    function scan(address user)
        public
        view
        returns (
            address[] memory aTokens,
            uint256[] memory aBalances,
            address[] memory debtAssets,
            uint256[] memory debtAmounts
        )
    {
        address[] memory reserves = POOL.getReservesList();
        ScanBuf memory b = ScanBuf({
            aTokens: new address[](reserves.length),
            aBalances: new uint256[](reserves.length),
            debtAssets: new address[](reserves.length),
            debtAmounts: new uint256[](reserves.length),
            nc: 0,
            nd: 0
        });

        _fill(user, reserves, b);

        aTokens = new address[](b.nc);
        aBalances = new uint256[](b.nc);
        debtAssets = new address[](b.nd);
        debtAmounts = new uint256[](b.nd);
        for (uint256 i; i < b.nc; ++i) {
            aTokens[i] = b.aTokens[i];
            aBalances[i] = b.aBalances[i];
        }
        for (uint256 i; i < b.nd; ++i) {
            debtAssets[i] = b.debtAssets[i];
            debtAmounts[i] = b.debtAmounts[i];
        }
    }

    /// @dev Every supplied balance is listed, not only the reserves flagged as collateral.
    ///      Aave accepts a supply without enabling collateral, for a zero loan to value reserve
    ///      or under isolation rules. Such a balance carries no collateral bit, and leaving it
    ///      behind would strand it in an account whose ownership token has been burned.
    /// @dev The user configuration bitmap is keyed by the reserve's own id, which stays fixed,
    ///      not by its place in the reserve list, which shifts when a reserve is dropped.
    function _fill(address user, address[] memory reserves, ScanBuf memory b) internal view {
        DataTypes.UserConfigurationMap memory cfg = POOL.getUserConfiguration(user);
        for (uint256 i; i < reserves.length; ++i) {
            DataTypes.ReserveDataLegacy memory rd = POOL.getReserveData(reserves[i]);

            uint256 bal = IERC20(rd.aTokenAddress).balanceOf(user);
            if (bal != 0) {
                b.aTokens[b.nc] = rd.aTokenAddress;
                b.aBalances[b.nc] = bal;
                ++b.nc;
            }

            if (cfg.isBorrowing(rd.id)) {
                uint256 owed = IERC20(rd.variableDebtTokenAddress).balanceOf(user);
                if (owed != 0) {
                    b.debtAssets[b.nd] = reserves[i];
                    b.debtAmounts[b.nd] = owed;
                    ++b.nd;
                }
            }
        }
    }

    /// @notice Value of everything `account` has supplied, in the oracle base currency.
    /// @dev Aave's own total counts only the reserves it treats as collateral, but a sale hands
    ///      over every supplied balance. A reserve with a zero loan to value, or one the owner
    ///      left out of their collateral, is worth real money to the buyer and has to be priced.
    function suppliedValueBase(address account) public view returns (uint256 total) {
        address[] memory reserves = POOL.getReservesList();
        IAaveOracle oracle = IAaveOracle(ADDRESSES_PROVIDER.getPriceOracle());

        for (uint256 i; i < reserves.length; ++i) {
            DataTypes.ReserveDataLegacy memory rd = POOL.getReserveData(reserves[i]);
            uint256 balance = IERC20(rd.aTokenAddress).balanceOf(account);
            if (balance == 0) continue;
            uint256 unit = 10 ** POOL.getConfiguration(reserves[i]).getDecimals();
            total += (balance * oracle.getAssetPrice(reserves[i])) / unit;
        }
    }

    /// @notice What `migrateOut` would change about `to`'s own Aave configuration, or
    ///         `Blocker.None` when it changes nothing.
    /// @dev Moving out is the mirror of moving in, and it carries the same trap. Aave enables a
    ///      reserve as collateral when an aToken lands on an empty balance, so a supply this
    ///      position deliberately kept out of its collateral starts backing `to`'s debt the moment
    ///      it arrives. Moving in repairs that by setting the flags afterwards, which only works
    ///      because the position account is ours to drive. `to` is not: that call has to come from
    ///      `to`. Refusing the move is not the answer either, because the balance would then be
    ///      stranded in the account with no way out at all. So the move goes ahead and this view
    ///      exists to say what it will do, in time for the interface to ask first. A balance `to`
    ///      already holds is left out, because Aave keeps the flag `to` chose for it.
    function migrateOutWarning(uint256 tokenId, address to) public view returns (Blocker) {
        address account = _account(tokenId);
        (address[] memory supplied, bool[] memory asCollateral) = _supplyFlags(account);
        for (uint256 i; i < supplied.length; ++i) {
            if (asCollateral[i]) continue;
            address aToken = POOL.getReserveData(supplied[i]).aTokenAddress;
            if (IERC20(aToken).balanceOf(to) == 0) return Blocker.CollateralFlagMismatch;
        }
        return Blocker.None;
    }

    /// @notice Why `user`'s Aave position cannot be migrated, or `Blocker.None` when it can.
    /// @dev Checked before the transaction so the interface can refuse with a readable reason.
    function migrationBlocker(address user) public view returns (Blocker) {
        address[] memory reserves = POOL.getReservesList();
        DataTypes.UserConfigurationMap memory cfg = POOL.getUserConfiguration(user);
        bool anyCollateral = false;

        for (uint256 i; i < reserves.length; ++i) {
            // The bitmap is keyed by the reserve id, which never moves, while the position in
            // the reserve list shifts whenever Aave drops a reserve.
            DataTypes.ReserveDataLegacy memory rd = POOL.getReserveData(reserves[i]);
            uint256 id = rd.id;
            bool collateral = cfg.isUsingAsCollateral(id);
            bool borrowing = cfg.isBorrowing(id);
            // A balance the user keeps out of their collateral still has to be moved, and a
            // paused reserve refuses the aToken transfer that moves it. Skipping this reserve
            // because it is neither collateral nor debt would promise a migration that reverts.
            bool supplied = IERC20(rd.aTokenAddress).balanceOf(user) != 0;
            if (!collateral && !borrowing && !supplied) continue;

            DataTypes.ReserveConfigurationMap memory rc = POOL.getConfiguration(reserves[i]);
            if (!rc.getActive()) return Blocker.ReserveInactive;
            if (rc.getPaused()) return Blocker.ReservePaused;

            if (collateral) {
                if (rc.getDebtCeiling() != 0) return Blocker.IsolationMode;
                anyCollateral = true;
            }
            if (borrowing) {
                if (rc.getFrozen()) return Blocker.ReserveFrozen;
                if (rc.getSiloedBorrowing()) return Blocker.SiloedBorrowing;
                // The debt is carried across by a flash loan that is repaid by borrowing the
                // same amount on the new account. Both halves need the reserve to allow them.
                if (!rc.getBorrowingEnabled()) return Blocker.BorrowingDisabled;
                if (!rc.getFlashLoanEnabled()) return Blocker.FlashLoanDisabled;
            }
        }
        if (!anyCollateral) return Blocker.NoCollateral;

        // A health factor above 1 is not enough. Aave reopens the debt through its borrow path,
        // which asks whether the collateral covers the debt at the loan to value ratio, a
        // stricter line than the liquidation threshold. Interest or a price fall can put a
        // position between the two, where it is not liquidatable but cannot be borrowed against.
        (uint256 collateralBase, uint256 debtBase,,, uint256 ltv,) = POOL.getUserAccountData(user);
        if (debtBase != 0 && (collateralBase * ltv) / 10_000 < debtBase) {
            return Blocker.DebtAboveLtv;
        }

        return Blocker.None;
    }

    // ---------------------------------------------------------------- internals

    function _account(uint256 tokenId) internal view returns (address account) {
        account = accountOf[tokenId];
        if (account == address(0)) revert UnknownPosition();
    }

    function _debtOf(address account, address asset) internal view returns (uint256) {
        return IERC20(POOL.getReserveData(asset).variableDebtTokenAddress).balanceOf(account);
    }

    /// @dev Aave refuses type(uint256).max when repaying for another address, so the exact
    ///      amount is used. It was read in this same block, so it clears the debt in full.
    function _repayAll(address[] calldata assets, uint256[] calldata amounts, address debtor)
        internal
    {
        for (uint256 i; i < assets.length; ++i) {
            IERC20(assets[i]).forceApprove(address(POOL), amounts[i]);
            POOL.repay(assets[i], amounts[i], VARIABLE_RATE, debtor);
        }
    }

    /// @dev Moves every supplied balance over and leaves the destination with the same
    ///      collateral flags the source had.
    function _carryCollateral(address user, address account, address[] memory aTokens) internal {
        (address[] memory supplied, bool[] memory asCollateral) = _supplyFlags(user);
        _pullCollateral(user, account, aTokens);
        _restoreCollateralFlags(account, supplied, asCollateral);
    }

    /// @dev Which reserves a user supplies, and whether each one counts as their collateral.
    ///      Read before the transfer so the destination can be made to match.
    function _supplyFlags(address user)
        internal
        view
        returns (address[] memory assets, bool[] memory asCollateral)
    {
        address[] memory reserves = POOL.getReservesList();
        DataTypes.UserConfigurationMap memory cfg = POOL.getUserConfiguration(user);

        address[] memory buf = new address[](reserves.length);
        bool[] memory flags = new bool[](reserves.length);
        uint256 n;

        for (uint256 i; i < reserves.length; ++i) {
            DataTypes.ReserveDataLegacy memory rd = POOL.getReserveData(reserves[i]);
            if (IERC20(rd.aTokenAddress).balanceOf(user) == 0) continue;
            buf[n] = reserves[i];
            flags[n] = cfg.isUsingAsCollateral(rd.id);
            ++n;
        }

        assets = new address[](n);
        asCollateral = new bool[](n);
        for (uint256 i; i < n; ++i) {
            assets[i] = buf[i];
            asCollateral[i] = flags[i];
        }
    }

    /// @dev Turns off collateral for the reserves the source had turned off. Anything the source
    ///      used as collateral is already enabled, because Aave does that on an incoming balance.
    function _restoreCollateralFlags(
        address account,
        address[] memory assets,
        bool[] memory asCollateral
    ) internal {
        for (uint256 i; i < assets.length; ++i) {
            if (asCollateral[i]) continue;
            PositionAccount(account)
                .execute(
                    address(POOL),
                    abi.encodeCall(IPool.setUserUseReserveAsCollateral, (assets[i], false))
                );
        }
    }

    function _modes(uint256 n) internal pure returns (uint256[] memory modes) {
        modes = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            modes[i] = VARIABLE_RATE;
        }
    }

    /// @dev Reads the balance at transfer time so accrued interest is carried over, not left behind.
    ///      `from` is the caller of migrateIn, checked by the caller, and the caller approved
    ///      these aTokens to this contract.
    /// forge-lint: disable-next-item(arbitrary-send-erc20)
    function _pullCollateral(address from, address to, address[] memory aTokens) internal {
        for (uint256 i; i < aTokens.length; ++i) {
            uint256 bal = IERC20(aTokens[i]).balanceOf(from);
            if (bal != 0) IERC20(aTokens[i]).safeTransferFrom(from, to, bal);
        }
    }

    function _moveCollateral(address account, address to, address[] memory aTokens) internal {
        for (uint256 i; i < aTokens.length; ++i) {
            uint256 bal = IERC20(aTokens[i]).balanceOf(account);
            if (bal != 0) {
                PositionAccount(account)
                    .execute(aTokens[i], abi.encodeCall(IERC20.transfer, (to, bal)));
            }
        }
    }

    function _setDelegation(address account, address[] memory assets, uint256[] memory amounts)
        internal
    {
        for (uint256 i; i < assets.length; ++i) {
            PositionAccount(account)
                .execute(
                    POOL.getReserveData(assets[i]).variableDebtTokenAddress,
                    abi.encodeCall(
                        ICreditDelegationToken.approveDelegation, (address(this), amounts[i])
                    )
                );
        }
    }

    /// @dev Leftover delegation would let this contract open debt later, so it is always reset.
    function _clearDelegation(address account, address[] memory assets) internal {
        for (uint256 i; i < assets.length; ++i) {
            PositionAccount(account)
                .execute(
                    POOL.getReserveData(assets[i]).variableDebtTokenAddress,
                    abi.encodeCall(ICreditDelegationToken.approveDelegation, (address(this), 0))
                );
        }
    }
}
