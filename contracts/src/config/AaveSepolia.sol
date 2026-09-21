// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Aave V3 Sepolia market addresses.
/// @dev Source: @aave-dao/aave-address-book v4.68.1, checked again on 2026-09-18 and
///      verified against chain state. Aave V4 exists but runs on mainnet only, so every
///      Aave testnet market is still V3. See docs/research/aave-testnet.md.
///      The local development chain is a fork of Sepolia, so the same addresses apply there.
library AaveSepolia {
    uint256 internal constant CHAIN_ID = 11155111;

    address internal constant POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address internal constant POOL_ADDRESSES_PROVIDER = 0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A;
    address internal constant POOL_CONFIGURATOR = 0x7Ee60D184C24Ef7AfC1Ec7Be59A0f448A0abd138;
    address internal constant ORACLE = 0x2da88497588bf89281816106C7259e31AF45a663;
    address internal constant ACL_ADMIN = 0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00;
    address internal constant ACL_MANAGER = 0x7F2bE3b178deeFF716CD6Ff03Ef79A1dFf360ddD;
    address internal constant DATA_PROVIDER = 0x3e9708d80f7B3e43118013075F7e95CE3AB31F31;
    address internal constant FAUCET = 0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D;
    address internal constant WETH_GATEWAY = 0x387d311e47e80b498169e6fb51d3193167d89F7D;

    // Underlying assets. WETH is wrapped Sepolia ether; the rest come from the faucet.
    address internal constant WETH = 0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c;
    address internal constant LINK = 0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5;
    address internal constant WBTC = 0x29f2D40B0605204364af54EC677bD022dA425d03;
    address internal constant USDT = 0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0;
    address internal constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address internal constant DAI = 0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357;

    // aTokens
    address internal constant A_WETH = 0x5b071b590a59395fE4025A0Ccc1FcC931AAc1830;
    address internal constant A_LINK = 0x3FfAf50D4F4E96eB78f2407c090b72e86eCaed24;
    address internal constant A_USDT = 0xAF0F6e8b0Dc5c913bbF4d14c22B4E78Dd14310B6;
    address internal constant A_DAI = 0x29598b72eb5CeBd806C5dCD549490FdA35B13cD8;

    // Variable debt tokens
    address internal constant V_USDT = 0x9844386d29EEd970B9F6a2B9a676083b0478210e;
    address internal constant V_DAI = 0x22675C506A8FC26447aFFfa33640f6af5d4D4cF0;
    address internal constant V_LINK = 0x34a4d932E722b9dFb492B9D8131127690CE2430B;

    /// @dev Chainlink style price feeds the Aave oracle reads. Replacing these is how the local
    ///      chain simulates a price move; on the public testnet they never change.
    address internal constant FEED_WETH = 0xDde0E8E6d3653614878Bf5009EDC317BC129fE2F;
    address internal constant FEED_LINK = 0x14fC51b7df22b4D393cD45504B9f0A3002A63F3F;
    address internal constant FEED_USDT = 0x4e86D3Aa271Fa418F38D7262fdBa2989C94aa5Ba;
    address internal constant FEED_USDC = 0x98458D6A99489F15e6eB5aFa67ACFAcf6F211051;
}
