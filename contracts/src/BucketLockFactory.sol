// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BucketLock } from "./BucketLock.sol";

/**
 * Deploys and records BucketLocks.
 *
 * PROVENANCE, STATED HONESTLY: this contract is the application's trust anchor,
 * not a cryptographic proof of arbitrary bytecode. The chain of reasoning the
 * frontend relies on is: the factory address is on a pinned chain-ID + address
 * allowlist -> `isLock(x)` says this factory created x -> the factory deploys the
 * fixed BucketLock creation bytecode compiled into it -> therefore x runs the
 * reviewed implementation with these constants.
 *
 * `isLock` proves PROVENANCE, never OWNERSHIP. Callers must check the lock's own
 * `owner()` separately. Treating provenance as ownership is a fund-loss path:
 * routing deposits into somebody else's lock is unrecoverable.
 *
 * "Factory-only" is a product statement, not a technical impossibility. Anyone
 * can deploy BucketLock directly and it will work correctly for them; it is
 * simply unsupported by this application and is never classified as eligible.
 *
 * No admin, no pause, no upgrade path, matching rule 1 of split-CLAUDE.md.
 * Changing the treasury or the penalty means deploying a NEW factory; existing
 * locks keep paying the treasury they were born with, forever.
 */
contract BucketLockFactory {
    /// Bumped whenever the deployed BucketLock bytecode or these constants change,
    /// so the frontend can pin an exact expected version per factory address.
    uint256 public constant VERSION     = 1;
    /// Mirrors BucketLock.PENALTY_BPS. Exposed so the frontend can assert the two
    /// agree before trusting a factory, rather than assuming they do.
    uint256 public constant PENALTY_BPS = 1_000;
    /// Shortest permitted lock. Mirrors Split.sol's own MIN_INTERVAL precedent and
    /// lives here rather than on the lock, which never receives it.
    uint64  public constant MIN_DURATION = 1 days;

    IERC20  public immutable token;
    address public immutable treasury;

    /// Provenance record. True only for addresses this factory itself deployed.
    mapping(address => bool) public isLock;

    /// Per-user history, read through the paginated accessors below. An
    /// unpaginated array getter is deliberately not exposed: per-user growth is
    /// unbounded in principle and a single large return can exceed RPC limits.
    mapping(address => address[]) private _locksOf;

    event LockCreated(
        address indexed owner,
        address indexed lock,
        uint64  unlockAt,
        uint256 target
    );

    error ZeroAddress();
    error DateRequired();
    error UnlockTooSoon();

    constructor(IERC20 _token, address _treasury) {
        if (address(_token) == address(0) || _treasury == address(0)) revert ZeroAddress();
        token    = _token;
        treasury = _treasury;
    }

    /**
     * Deploy a lock owned by the caller.
     *
     * A date is always required. A target-only lock that never reaches its target
     * would never become penalty-free, since time passing alone would not help, so
     * its only exit would be paying the penalty indefinitely. `target == 0` is
     * fully legal and means date-only; a positive target is an optional EARLIER
     * unlock condition.
     */
    function createLock(uint64 unlockAt, uint256 target) external returns (address lock) {
        if (unlockAt == 0) revert DateRequired();
        if (unlockAt < block.timestamp + MIN_DURATION) revert UnlockTooSoon();

        lock = address(new BucketLock(msg.sender, token, treasury, unlockAt, target));

        isLock[lock] = true;
        _locksOf[msg.sender].push(lock);

        emit LockCreated(msg.sender, lock, unlockAt, target);
    }

    // ─── Paginated discovery ──────────────────────────────────────────────
    // Read newest-first by walking `locksOfLength(user) - 1` downwards. Needs no
    // extra API and keeps the frontend from scanning a user's whole history on
    // every dashboard render.

    function locksOfLength(address user) external view returns (uint256) {
        return _locksOf[user].length;
    }

    function locksOfAt(address user, uint256 index) external view returns (address) {
        return _locksOf[user][index];
    }
}
