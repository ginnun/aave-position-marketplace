// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Settable Chainlink style price feed, used only on the local development chain.
/// @dev The local environment swaps a reserve's price source for this contract so tests can
///      move a price and watch the health factor react. The public testnet keeps its own feeds.
contract MockAggregator {
    error NotOwner();

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    address public owner;
    int256 private _answer;
    uint8 public immutable decimals;
    uint80 private _round;
    uint256 private _updatedAt;

    constructor(int256 initialAnswer, uint8 decimals_) {
        owner = msg.sender;
        _answer = initialAnswer;
        decimals = decimals_;
        _round = 1;
        _updatedAt = block.timestamp;
    }

    function setAnswer(int256 answer) external {
        if (msg.sender != owner) revert NotOwner();
        _answer = answer;
        _round += 1;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(answer, _round, block.timestamp);
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestTimestamp() external view returns (uint256) {
        return _updatedAt;
    }

    function latestRound() external view returns (uint256) {
        return _round;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }

    function description() external pure returns (string memory) {
        return "Local mock feed";
    }

    function version() external pure returns (uint256) {
        return 1;
    }
}
