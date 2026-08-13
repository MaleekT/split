// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * A single user's locked savings bucket.
 *
 * WHY THIS EXISTS AS A SEPARATE CONTRACT: Split.withdraw has no hook, guard, or
 * external permissioning, so nothing outside Split can gate funds sitting in a
 * bucket's `balance`. A lock therefore cannot be a hold bucket. It is an
 * auto-send bucket whose destination is one of these, so Split._split pushes the
 * bucket's share straight here on every deposit and the money is never in Split's
 * accounting to begin with.
 *
 * Deployed in full by BucketLockFactory, NOT as an EIP-1167 clone: a clone
 * executes the implementation's bytecode, and `immutable` values live in
 * bytecode, so per-clone immutables are impossible. Full deployment means every
 * parameter below is genuinely immutable and there is no initialize() to
 * front-run, re-enter, or forget to disable on an implementation.
 *
 * NO receive() AND NO fallback(), DELIBERATELY. Verified on Arc Testnet
 * (chain 5042002, block 56820467): a plain ERC-20 `transfer` to a contract with
 * neither succeeds, so Split can still pay this contract; while a direct NATIVE
 * value transfer to such a contract reverts, so stray native value cannot be
 * trapped here. On Arc an address's native balance and its USDC facade balance
 * are the same pot (measured: 317671976693280850003 wei / 1e12 == 317671976 raw),
 * which is also why no native rescue path exists: any such path would move locked
 * USDC and bypass the early-withdrawal penalty.
 *
 * There is no rescue function of any kind. Moving a foreign ERC-20 could not be
 * proven independent of the configured token's balance under that unified-balance
 * model, and an unproven guarantee is not one. Foreign tokens sent here are
 * permanently stuck, which is the documented, deliberate tradeoff.
 */
contract BucketLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_TOTAL   = 10_000;
    /// Fixed at exactly 10%. Not a constructor argument, so "exactly 10%" is a
    /// property of the code rather than of whatever a factory was deployed with.
    uint256 public constant PENALTY_BPS = 1_000;

    address public immutable owner;
    IERC20  public immutable token;
    address public immutable treasury;

    /// Unix seconds. Always non-zero via the factory, which requires a date.
    uint64  public immutable unlockAt;
    /// Raw 6-decimal units. Zero means "no target condition", i.e. date-only.
    uint256 public immutable target;

    /// Latched true the first time the live balance meets `target`. Monotonic:
    /// nothing in this contract ever writes it back to false. Without the latch,
    /// withdrawing below the target would silently re-lock the remainder.
    bool public targetMet;

    event TargetMet(uint256 balance, uint256 target);
    event Withdrawn(
        address indexed owner,
        uint256 grossAmount,
        uint256 penalty,
        uint256 netAmount,
        bool    early
    );

    error NotOwner();
    error ZeroAddress();
    error NoUnlockCondition();
    error UnlockInPast();
    error InvalidAmount();
    error InsufficientBalance();
    error PenaltyExceedsAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _owner,
        IERC20  _token,
        address _treasury,
        uint64  _unlockAt,
        uint256 _target
    ) {
        if (_owner == address(0) || address(_token) == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        // Validates only what it receives. MIN_DURATION lives on the factory and
        // is deliberately not referenced here: this contract cannot check a value
        // it was never given. A lock constructed directly, bypassing the factory,
        // still cannot be created with no condition or a date already in the past.
        if (_unlockAt == 0 && _target == 0) revert NoUnlockCondition();
        // Intentional timestamp comparison, same rationale as Split.sol's scheduled
        // sends: Arc's ~0.48s blocks make manipulation negligible against a minimum
        // lock duration measured in days.
        // forge-lint: disable-next-line(block-timestamp)
        if (_unlockAt != 0 && _unlockAt <= block.timestamp) revert UnlockInPast();

        owner    = _owner;
        token    = _token;
        treasury = _treasury;
        unlockAt = _unlockAt;
        target   = _target;
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /**
     * Unlocked when the date has passed OR the target has been reached. The live
     * balance is checked as well as the latch, so a lock that has reached its
     * target reads as unlocked even if nobody has ever called poke().
     *
     * The target is measured against the CURRENT balance, not cumulative
     * receipts. Cumulative is unimplementable: ERC-20 has no receiver callback and
     * Split._split sends a plain transfer with no calldata, so this contract
     * cannot execute any code when funds arrive. A documented consequence is that
     * anyone can send USDC here and push it over its target, unlocking it early.
     * That is not a fund-loss path, since only `owner` can ever withdraw; a third
     * party can remove someone's penalty, never take their money.
     */
    function isUnlocked() public view returns (bool) {
        // Intentional timestamp comparison; see the constructor's note.
        // forge-lint: disable-next-line(block-timestamp)
        if (unlockAt != 0 && block.timestamp >= unlockAt) return true;
        if (targetMet) return true;
        if (target != 0 && token.balanceOf(address(this)) >= target) return true;
        return false;
    }

    /**
     * Hypothetical arithmetic only: no balance read, no unlock evaluation, and no
     * dust revert. Returns (1, 0) for a one-unit early amount rather than
     * reverting, because this is a calculator, not a gate.
     *
     * It exists because the migration confirmation has to quote a cost BEFORE the
     * lock holds anything, and previewWithdraw would revert against an empty
     * balance. Callers must present the result conditionally: it cannot know
     * whether the lock will still be locked when a withdrawal actually happens.
     */
    function quotePenalty(uint256 amount) external pure returns (uint256 penalty, uint256 net) {
        penalty = _penalty(amount);
        net     = amount - penalty;
    }

    /**
     * Current-block truth: validates the amount against the live balance and the
     * live unlock state, and reverts exactly where withdraw() would. Equals
     * execution at identical block state. The mined transaction remains
     * authoritative; a stale preview may revert and callers must treat that as
     * retryable rather than as failure.
     */
    function previewWithdraw(uint256 amount)
        external
        view
        returns (uint256 net, uint256 penalty, bool early)
    {
        if (amount == 0) revert InvalidAmount();
        if (amount > token.balanceOf(address(this))) revert InsufficientBalance();

        // Mirrors _withdraw's shape exactly, including the dust revert, so a
        // preview can never promise something execution would refuse.
        early = !isUnlocked();
        if (early) {
            penalty = _penalty(amount);
            if (penalty >= amount) revert PenaltyExceedsAmount();
        }
        net = amount - penalty;
    }

    // ─── Actions ──────────────────────────────────────────────────────────

    /// Latch the target without withdrawing. Permissionless on purpose: latching
    /// can only ever make a lock MORE open, never less, so there is nothing to
    /// gain by calling it on someone else's lock.
    function poke() external {
        _latch();
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        _withdraw(amount);
    }

    function withdrawAll() external onlyOwner nonReentrant {
        // Routed through the same internal path rather than reimplementing the
        // arithmetic, so the two can never drift apart.
        _withdraw(token.balanceOf(address(this)));
    }

    // ─── Internals ────────────────────────────────────────────────────────

    /// Ceiling division. Math.mulDiv carries a 512-bit intermediate, so this is
    /// correct for every uint256 input, including values near type(uint256).max
    /// where `amount * PENALTY_BPS` would overflow. Balances here are ERC-20
    /// uint256, not Split's uint128, so that headroom is load-bearing.
    function _penalty(uint256 amount) internal pure returns (uint256) {
        return Math.mulDiv(amount, PENALTY_BPS, BPS_TOTAL, Math.Rounding.Ceil);
    }

    function _latch() internal {
        if (!targetMet && target != 0) {
            uint256 balance = token.balanceOf(address(this));
            if (balance >= target) {
                targetMet = true;
                emit TargetMet(balance, target);
            }
        }
    }

    function _withdraw(uint256 amount) internal {
        if (amount == 0) revert InvalidAmount();

        uint256 balance = token.balanceOf(address(this));
        if (amount > balance) revert InsufficientBalance();

        // Latch BEFORE deciding whether this is early, and unconditionally of the
        // date. A lock whose date has already passed can still have met its
        // target, and that fact has to be recorded permanently even though it does
        // not change this particular withdrawal's outcome.
        _latch();

        bool early = !isUnlocked();

        uint256 penalty = 0;
        if (early) {
            penalty = _penalty(amount);
            // Only reachable at amount == 1, where ceiling rounding takes the whole
            // unit. Rejecting is better than transferring zero to the owner and
            // calling it a withdrawal.
            if (penalty >= amount) revert PenaltyExceedsAmount();
        }
        uint256 net = amount - penalty;

        // Checks and effects are done: the only mutable state is `targetMet`,
        // already written above. Interactions last, and nonReentrant guards the
        // pair regardless.
        if (penalty > 0) token.safeTransfer(treasury, penalty);
        token.safeTransfer(owner, net);

        emit Withdrawn(owner, amount, penalty, net, early);
    }
}
