// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "aave-v3-origin/contracts/interfaces/IPool.sol";
import {
    IPoolAddressesProvider
} from "aave-v3-origin/contracts/interfaces/IPoolAddressesProvider.sol";
import {IAaveOracle} from "aave-v3-origin/contracts/interfaces/IAaveOracle.sol";
import {
    ICreditDelegationToken
} from "aave-v3-origin/contracts/interfaces/ICreditDelegationToken.sol";

import {AaveSepolia} from "../src/config/AaveSepolia.sol";
import {IFaucet, IWETH} from "../src/config/IFaucet.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Shared setup: a Sepolia fork with the real Aave V3 market plus our contracts on top.
abstract contract ForkBase is Test {
    IPool internal pool = IPool(AaveSepolia.POOL);
    IAaveOracle internal oracle = IAaveOracle(AaveSepolia.ORACLE);
    IFaucet internal faucet = IFaucet(AaveSepolia.FAUCET);

    PositionManager internal manager;
    Marketplace internal market;

    address internal admin = makeAddr("admin");
    address internal feeSink = makeAddr("feeSink");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant FEE_BPS = 50; // 0.5%

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"), vm.envUint("FORK_BLOCK"));

        vm.startPrank(admin);
        manager =
            new PositionManager(pool, IPoolAddressesProvider(AaveSepolia.POOL_ADDRESSES_PROVIDER));
        market = new Marketplace(manager, FEE_BPS, feeSink, admin);
        manager.setEscrow(market);
        market.setPaymentAsset(AaveSepolia.USDC, true);
        market.setPaymentAsset(AaveSepolia.DAI, true);
        vm.stopPrank();

        vm.label(address(manager), "PositionManager");
        vm.label(address(market), "Marketplace");
        vm.label(AaveSepolia.POOL, "AavePool");
        vm.label(AaveSepolia.WETH, "WETH");
        vm.label(AaveSepolia.USDT, "USDT");
        vm.label(AaveSepolia.USDC, "USDC");
    }

    // ------------------------------------------------------------------ funding

    /// @dev Wraps ether into the market's WETH test token.
    function giveWeth(address to, uint256 amount) internal {
        vm.deal(to, amount);
        vm.prank(to);
        IWETH(AaveSepolia.WETH).deposit{value: amount}();
    }

    /// @dev Funds a test token by writing the balance directly. The faucet caps one call at
    ///      MAX_MINT_AMOUNT whole units, which is too small for some test scenarios.
    function giveToken(address token, address to, uint256 amount) internal {
        deal(token, to, IERC20(token).balanceOf(to) + amount);
    }

    /// @dev Mints through the real Aave faucet, the path the seed script and the user interface use.
    function faucetMint(address token, address to, uint256 amount) internal {
        vm.prank(to);
        faucet.mint(token, to, amount);
    }

    // ------------------------------------------------------------------ positions

    /// @notice Builds a plain Aave position owned by `user`: WETH collateral, USDT debt.
    function openAavePosition(address user, uint256 collateralWeth, uint256 debtUsdt) internal {
        giveWeth(user, collateralWeth);
        vm.startPrank(user);
        IERC20(AaveSepolia.WETH).approve(address(pool), collateralWeth);
        pool.supply(AaveSepolia.WETH, collateralWeth, user, 0);
        if (debtUsdt != 0) pool.borrow(AaveSepolia.USDT, debtUsdt, 2, 0, user);
        vm.stopPrank();
    }

    /// @notice Moves a plain Aave position into a tradable position, approvals included.
    function migrateIn(address user) internal returns (uint256 tokenId) {
        (address[] memory aTokens,,,) = manager.scan(user);
        vm.startPrank(user);
        for (uint256 i; i < aTokens.length; ++i) {
            IERC20(aTokens[i]).approve(address(manager), type(uint256).max);
        }
        tokenId = manager.migrateIn();
        vm.stopPrank();
    }

    /// @notice Grants the manager the credit delegation a migrate-out needs.
    function delegateForMigrateOut(address user, uint256 tokenId) internal {
        (,, address[] memory debtAssets,) = manager.scan(manager.accountOf(tokenId));
        vm.startPrank(user);
        for (uint256 i; i < debtAssets.length; ++i) {
            ICreditDelegationToken(pool.getReserveData(debtAssets[i]).variableDebtTokenAddress)
                .approveDelegation(address(manager), type(uint256).max);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ market simulation

    /// @dev Points a reserve at a fresh mock feed so the test can move its price.
    function replaceFeed(address asset, int256 priceE8) internal returns (MockAggregator feed) {
        feed = new MockAggregator(priceE8, 8);
        address[] memory assets = new address[](1);
        address[] memory sources = new address[](1);
        assets[0] = asset;
        sources[0] = address(feed);
        vm.prank(AaveSepolia.ACL_ADMIN);
        oracle.setAssetSources(assets, sources);
    }

    function healthFactor(uint256 tokenId) internal view returns (uint256 hf) {
        (,,,,, hf) = manager.accountData(tokenId);
    }

    function netValueBase(uint256 tokenId) internal view returns (uint256) {
        (uint256 collateral, uint256 debt,,,,) = manager.accountData(tokenId);
        return collateral - debt;
    }

    function defaultLimits(uint256 maxPrice) internal view returns (Marketplace.BuyLimits memory) {
        return Marketplace.BuyLimits({
            paymentAsset: AaveSepolia.USDC,
            maxPrice: maxPrice,
            minNetValueBase: 0,
            maxDebtBase: type(uint256).max,
            minHealthFactor: 0,
            deadline: block.timestamp + 1 hours
        });
    }

    function defaultListing(uint256 fixedPrice) internal view returns (Marketplace.Listing memory) {
        return Marketplace.Listing({
            seller: address(0),
            paymentAsset: AaveSepolia.USDC,
            allowedBuyer: address(0),
            fixedPrice: fixedPrice,
            minPrice: 0,
            rateBps: 0,
            expiry: uint64(vm.getBlockTimestamp() + 7 days),
            minHealthFactor: 1.05e18,
            quickSale: false
        });
    }
}
