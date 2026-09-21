// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPool} from "aave-v3-origin/contracts/interfaces/IPool.sol";
import {
    IPoolAddressesProvider
} from "aave-v3-origin/contracts/interfaces/IPoolAddressesProvider.sol";
import {IAaveOracle} from "aave-v3-origin/contracts/interfaces/IAaveOracle.sol";

import {PositionManager} from "./PositionManager.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";

/// @notice Escrow marketplace for tradable Aave positions.
/// @dev A listed position lives in this contract as the ERC-721 owner. That single fact is what
///      the PositionManager reads to block weakening actions, so there is no separate lock state.
contract Marketplace is IEscrow, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Hard cap on the platform fee. Immutable by design: the admin can never raise it.
    uint256 public constant MAX_FEE_BPS = 200; // 2%
    /// @dev Upper bound for a dynamic listing rate, as a share of net value.
    uint256 public constant MAX_RATE_BPS = 15_000; // 150%
    uint256 public constant MAX_DURATION = 90 days;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    struct Listing {
        address seller;
        address paymentAsset;
        address allowedBuyer; // address(0) means anyone may buy
        uint256 fixedPrice; // used when rateBps == 0
        uint256 minPrice; // floor for dynamic listings, protects the seller
        uint16 rateBps; // 0 means fixed price; otherwise price = net value * rateBps / 10000
        uint64 expiry;
        uint256 minHealthFactor; // wad; below this the listing is invalid, not buyable
        bool quickSale; // seller marked this as a discounted fast exit
    }

    /// @notice Buyer guard rails, all checked against chain state inside the buy transaction.
    struct BuyLimits {
        /// @dev The asset the buyer agreed to pay in. Without it a seller could front-run the
        ///      purchase with updateListing, swap the listing to another token the buyer has
        ///      approved, and have maxPrice compared against a different number of decimals.
        address paymentAsset;
        uint256 maxPrice;
        uint256 minNetValueBase;
        uint256 maxDebtBase;
        uint256 minHealthFactor;
        uint256 deadline;
    }

    /// @dev Which buyer limit stopped a purchase. Surfaced so the interface can name it.
    enum Limit {
        Price,
        NetValue,
        Debt,
        HealthFactor,
        Deadline,
        PaymentAsset
    }

    error NotSeller();
    error NotListed();
    error AlreadyListed();
    error ListingExpired();
    error ListingInvalid(); // health factor under the seller threshold
    error SelfPurchase();
    error NotAllowedBuyer();
    error LimitExceeded(Limit limit);
    error BadParams();
    error PaymentAssetNotAllowed();
    error FeeTooHigh();
    error Paused();
    error NoPrice();

    event Listed(uint256 indexed tokenId, address indexed seller, Listing listing);
    event ListingUpdated(uint256 indexed tokenId, Listing listing);
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);
    event ListingClosed(uint256 indexed tokenId, address indexed seller);
    event Sold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        address paymentAsset,
        uint256 price,
        uint256 fee,
        uint256 netValueBase,
        uint256 debtBase
    );
    event FeeUpdated(uint256 feeBps, address feeRecipient);
    event PausedUpdated(bool paused);
    event PaymentAssetUpdated(address asset, bool allowed);

    PositionManager public immutable MANAGER;
    IPool public immutable POOL;
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;

    uint256 public feeBps;
    address public feeRecipient;
    bool public paused;

    mapping(uint256 tokenId => Listing) internal _listings;
    mapping(address asset => bool) public allowedPaymentAsset;

    constructor(PositionManager manager, uint256 feeBps_, address feeRecipient_, address owner_)
        Ownable(owner_)
    {
        MANAGER = manager;
        POOL = manager.POOL();
        ADDRESSES_PROVIDER = manager.ADDRESSES_PROVIDER();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert BadParams();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feeBps_, feeRecipient_);
    }

    // ---------------------------------------------------------------- escrow view

    /// @inheritdoc IEscrow
    function sellerOf(uint256 tokenId) external view returns (address) {
        return _listings[tokenId].seller;
    }

    function getListing(uint256 tokenId) external view returns (Listing memory) {
        return _listings[tokenId];
    }

    // ---------------------------------------------------------------- seller side

    function list(uint256 tokenId, Listing calldata params) external nonReentrant {
        if (paused) revert Paused();
        if (_listings[tokenId].seller != address(0)) revert AlreadyListed();
        _validate(params);

        Listing memory l = params;
        l.seller = msg.sender;
        _listings[tokenId] = l;

        // Pulls the ownership token into escrow. From here the PositionManager refuses
        // withdrawals and new borrows for this position.
        MANAGER.transferFrom(msg.sender, address(this), tokenId);
        emit Listed(tokenId, msg.sender, l);
    }

    function updateListing(uint256 tokenId, Listing calldata params) external nonReentrant {
        if (paused) revert Paused();
        Listing storage stored = _listings[tokenId];
        if (stored.seller == address(0)) revert NotListed();
        if (stored.seller != msg.sender) revert NotSeller();
        _validate(params);

        Listing memory l = params;
        l.seller = msg.sender;
        _listings[tokenId] = l;
        emit ListingUpdated(tokenId, l);
    }

    /// @notice Cancel and take the position back. Works even while the platform is paused.
    function cancel(uint256 tokenId) external nonReentrant {
        Listing memory l = _listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (l.seller != msg.sender) revert NotSeller();
        delete _listings[tokenId];
        MANAGER.transferFrom(address(this), l.seller, tokenId);
        emit ListingCancelled(tokenId, l.seller);
    }

    /// @notice Anyone may clear an expired listing. The position always goes back to the seller.
    function closeExpired(uint256 tokenId) external nonReentrant {
        Listing memory l = _listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (block.timestamp <= l.expiry) revert BadParams();
        delete _listings[tokenId];
        MANAGER.transferFrom(address(this), l.seller, tokenId);
        emit ListingClosed(tokenId, l.seller);
    }

    // ---------------------------------------------------------------- buyer side

    /// @notice Buy a listed position. Payment and ownership move in the same transaction or not at all.
    function buy(uint256 tokenId, BuyLimits calldata limits) external nonReentrant {
        if (paused) revert Paused();

        Listing memory l = _listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (block.timestamp > l.expiry) revert ListingExpired();
        if (msg.sender == l.seller) revert SelfPurchase();
        if (l.allowedBuyer != address(0) && l.allowedBuyer != msg.sender) revert NotAllowedBuyer();
        if (block.timestamp > limits.deadline) revert LimitExceeded(Limit.Deadline);
        if (l.paymentAsset != limits.paymentAsset) revert LimitExceeded(Limit.PaymentAsset);
        // The allowlist exists so a fee-on-transfer token cannot break the payment split. A
        // listing opened before the owner removed an asset would otherwise keep settling in it.
        // The seller still gets out through cancel or updateListing.
        if (!allowedPaymentAsset[l.paymentAsset]) revert PaymentAssetNotAllowed();

        // Effects before interactions: a second buyer in the same block finds no listing.
        delete _listings[tokenId];

        (uint256 netValueBase, uint256 debtBase, uint256 healthFactor) = _positionState(tokenId);

        if (healthFactor < l.minHealthFactor) revert ListingInvalid();
        if (netValueBase < limits.minNetValueBase) revert LimitExceeded(Limit.NetValue);
        if (debtBase > limits.maxDebtBase) revert LimitExceeded(Limit.Debt);
        if (healthFactor < limits.minHealthFactor) revert LimitExceeded(Limit.HealthFactor);

        uint256 price = _price(l, netValueBase);
        if (price > limits.maxPrice) revert LimitExceeded(Limit.Price);

        uint256 fee = Math.mulDiv(price, feeBps, BPS);
        uint256 toSeller = price - fee; // seller amount plus fee always equals the price

        IERC20 pay = IERC20(l.paymentAsset);
        pay.safeTransferFrom(msg.sender, l.seller, toSeller);
        if (fee != 0) pay.safeTransferFrom(msg.sender, feeRecipient, fee);

        // transferFrom, not safeTransferFrom: no receiver callback, so no reentrancy surface.
        MANAGER.transferFrom(address(this), msg.sender, tokenId);

        emit Sold(tokenId, l.seller, msg.sender, l.paymentAsset, price, fee, netValueBase, debtBase);
    }

    // ---------------------------------------------------------------- pricing

    /// @notice Price a listing would charge right now, in payment asset units.
    function currentPrice(uint256 tokenId) external view returns (uint256) {
        Listing memory l = _listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        (uint256 netValueBase,,) = _positionState(tokenId);
        return _price(l, netValueBase);
    }

    function _price(Listing memory l, uint256 netValueBase) internal view returns (uint256 price) {
        if (l.rateBps == 0) return l.fixedPrice;

        uint256 priceBase = Math.mulDiv(netValueBase, l.rateBps, BPS, Math.Rounding.Ceil);
        uint256 assetPrice =
            IAaveOracle(ADDRESSES_PROVIDER.getPriceOracle()).getAssetPrice(l.paymentAsset);
        if (assetPrice == 0) revert NoPrice();
        uint256 unit = 10 ** IERC20Metadata(l.paymentAsset).decimals();
        // Rounding up keeps the rounding error on the seller's side.
        price = Math.mulDiv(priceBase, unit, assetPrice, Math.Rounding.Ceil);
        if (price < l.minPrice) price = l.minPrice;
    }

    /// @dev Net value counts every supplied balance, because that is what the buyer receives.
    ///      Aave's own collateral total leaves out reserves it will not lend against, and pricing
    ///      by that number would hand those balances over for nothing. The health factor still
    ///      comes from Aave, since that is a statement about risk rather than about value.
    function _positionState(uint256 tokenId)
        internal
        view
        returns (uint256 netValueBase, uint256 debtBase, uint256 healthFactor)
    {
        address account = MANAGER.accountOf(tokenId);
        (, uint256 totalDebtBase,,,, uint256 hf) = POOL.getUserAccountData(account);
        uint256 supplied = MANAGER.suppliedValueBase(account);
        netValueBase = supplied > totalDebtBase ? supplied - totalDebtBase : 0;
        debtBase = totalDebtBase;
        healthFactor = hf;
    }

    // ---------------------------------------------------------------- admin

    function setFee(uint256 feeBps_, address feeRecipient_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert BadParams();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feeBps_, feeRecipient_);
    }

    /// @notice Emergency stop for new listings and purchases. Cancel and close stay open.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedUpdated(paused_);
    }

    /// @dev Allowlisted so fee-on-transfer tokens cannot break the payment split.
    function setPaymentAsset(address asset, bool allowed) external onlyOwner {
        allowedPaymentAsset[asset] = allowed;
        emit PaymentAssetUpdated(asset, allowed);
    }

    // ---------------------------------------------------------------- internals

    function _validate(Listing calldata p) internal view {
        if (!allowedPaymentAsset[p.paymentAsset]) revert PaymentAssetNotAllowed();
        if (p.expiry <= block.timestamp || p.expiry > block.timestamp + MAX_DURATION) {
            revert BadParams();
        }
        if (p.rateBps > MAX_RATE_BPS) revert BadParams();
        if (p.rateBps == 0 && p.fixedPrice == 0) revert BadParams();
        if (p.minHealthFactor < WAD) revert BadParams();
        // A dynamic price is quoted through the oracle on every read. An allowlisted asset the
        // oracle does not price would let the listing open and then fail every purchase, and the
        // seller would only learn that from a buyer's failed transaction.
        if (p.rateBps != 0) {
            uint256 assetPrice =
                IAaveOracle(ADDRESSES_PROVIDER.getPriceOracle()).getAssetPrice(p.paymentAsset);
            if (assetPrice == 0) revert NoPrice();
        }
    }
}
