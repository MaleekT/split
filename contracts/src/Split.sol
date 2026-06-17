// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Split is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable USDC;
    address public immutable scheduler;

    uint256 public constant MAX_BUCKETS  = 10;
    uint256 public constant BPS_TOTAL    = 10_000;
    uint64  public constant MIN_INTERVAL = 1 days;

    struct Bucket {
        uint256 id;
        string  name;
        uint16  bps;
        address destination; // address(0) = hold in contract
        uint128 balance;
        bool    active;
    }

    struct ScheduledSend {
        uint128 amount;
        uint64  interval;
        uint64  nextSendAt;
        address destination;
        bool    active;
    }

    mapping(address => Bucket[])                          private userBuckets;
    mapping(address => uint256)                           private userBucketCount;
    mapping(address => uint256)                           private nextBucketId;
    mapping(address => mapping(uint256 => ScheduledSend)) private scheduledSends;

    event BucketAdded(address indexed user, uint256 bucketId, string name, uint16 bps, address destination);
    event BucketUpdated(address indexed user, uint256 bucketId, string name, uint16 bps, address destination);
    event BucketDeleted(address indexed user, uint256 bucketId);
    event Deposited(address indexed recipient, address indexed sender, uint128 amount);
    event BucketSplit(address indexed user, uint256 indexed bucketId, uint128 share, address destination);
    event Withdrawn(address indexed user, uint256 indexed bucketId, uint128 amount, address to);
    event ScheduledSendSet(address indexed user, uint256 indexed bucketId);
    event ScheduledSendCancelled(address indexed user, uint256 indexed bucketId);
    event ScheduledSendExecuted(address indexed user, uint256 indexed bucketId, uint128 amount, address destination);

    error TooManyBuckets();
    error BucketNotFound();
    error ExceedsBPS();
    error InvalidBPSTotal();
    error InsufficientBalance();
    error NotScheduler();
    error TooEarly();
    error InvalidInterval();
    error NoBuckets();
    error DestinationRequired();
    error InvalidAmount();

    constructor(address _usdc, address _scheduler) {
        require(_usdc != address(0) && _scheduler != address(0), "zero");
        USDC      = IERC20(_usdc);
        scheduler = _scheduler;
    }

    // ─── Bucket management ────────────────────────────────────────────────

    // destination == address(0) is valid and intentional: it designates a hold bucket
    // (USDC accumulates in the contract, withdrawable by the user at any time).
    // destination != address(0) designates an auto-send bucket (USDC pushed out on every deposit).
    function addBucket(string calldata name, uint16 bps, address destination) external returns (uint256 id) {
        if (userBucketCount[msg.sender] >= MAX_BUCKETS) revert TooManyBuckets();
        if (_sumBPS(msg.sender) + bps > BPS_TOTAL) revert ExceedsBPS();
        id = nextBucketId[msg.sender]++;
        userBuckets[msg.sender].push(Bucket({
            id:          id,
            name:        name,
            bps:         bps,
            destination: destination,
            balance:     0,
            active:      true
        }));
        userBucketCount[msg.sender]++;
        emit BucketAdded(msg.sender, id, name, bps, destination);
    }

    function updateBucket(uint256 bucketId, string calldata name, uint16 newBps, address destination) external {
        uint256 idx = _getIdx(msg.sender, bucketId);
        Bucket storage b = userBuckets[msg.sender][idx];
        uint256 newTotal = _sumBPSExcluding(msg.sender, bucketId) + newBps;
        if (newTotal > BPS_TOTAL) revert ExceedsBPS();
        b.name        = name;
        b.bps         = newBps;
        b.destination = destination;
        emit BucketUpdated(msg.sender, bucketId, name, newBps, destination);
    }

    function deleteBucket(uint256 bucketId) external nonReentrant {
        uint256 idx = _getIdx(msg.sender, bucketId);
        Bucket storage b = userBuckets[msg.sender][idx];
        if (b.balance > 0) {
            uint128 bal = b.balance;
            b.balance   = 0;
            USDC.safeTransfer(msg.sender, bal);
            emit Withdrawn(msg.sender, bucketId, bal, msg.sender);
        }
        if (scheduledSends[msg.sender][bucketId].active) {
            scheduledSends[msg.sender][bucketId].active = false;
            emit ScheduledSendCancelled(msg.sender, bucketId);
        }
        Bucket[] storage arr = userBuckets[msg.sender];
        uint256 last = arr.length - 1;
        if (idx != last) arr[idx] = arr[last];
        arr.pop();
        userBucketCount[msg.sender]--;
        emit BucketDeleted(msg.sender, bucketId);
    }

    // ─── Deposits ─────────────────────────────────────────────────────────

    function deposit(uint128 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        _split(msg.sender, msg.sender, amount);
    }

    function depositFor(address recipient, uint128 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        _split(recipient, msg.sender, amount);
    }

    function _split(address user, address sender, uint128 amount) internal {
        Bucket[] storage arr = userBuckets[user];
        uint256 len = arr.length;
        if (len == 0) revert NoBuckets();
        if (_sumBPS(user) != BPS_TOTAL) revert InvalidBPSTotal();
        emit Deposited(user, sender, amount);
        uint128 remaining   = amount;
        uint256 lastHoldIdx = type(uint256).max;
        for (uint256 i = 0; i < len; ) {
            Bucket storage b = arr[i];
            if (b.active) {
                // Safe: (amount * bps) / 10000 <= amount <= uint128 max by construction.
                // forge-lint: disable-next-line(unsafe-typecast)
                uint128 share = uint128((uint256(amount) * b.bps) / BPS_TOTAL);
                // Cannot underflow: _sumBPS == BPS_TOTAL enforced above, so
                // sum of floor(amount*bps/BPS_TOTAL) across all buckets <= amount.
                remaining    -= share;
                if (b.destination != address(0)) {
                    USDC.safeTransfer(b.destination, share);
                } else {
                    b.balance  += share;
                    lastHoldIdx = i;
                }
                emit BucketSplit(user, b.id, share, b.destination);
            }
            unchecked { i++; }
        }
        if (remaining > 0 && lastHoldIdx != type(uint256).max) {
            arr[lastHoldIdx].balance += remaining;
        }
    }

    // ─── Withdrawals ──────────────────────────────────────────────────────

    function withdraw(uint256 bucketId, uint128 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 idx = _getIdx(msg.sender, bucketId);
        Bucket storage b = userBuckets[msg.sender][idx];
        if (b.balance < amount) revert InsufficientBalance();
        b.balance -= amount;
        USDC.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, bucketId, amount, msg.sender);
    }

    function withdrawTo(uint256 bucketId, uint128 amount, address to) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        require(to != address(0), "bad to");
        uint256 idx = _getIdx(msg.sender, bucketId);
        Bucket storage b = userBuckets[msg.sender][idx];
        if (b.balance < amount) revert InsufficientBalance();
        b.balance -= amount;
        USDC.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, bucketId, amount, to);
    }

    // ─── Scheduled sends ──────────────────────────────────────────────────

    function setScheduledSend(
        uint256 bucketId,
        uint128 amount,
        uint64  interval,
        address destination
    ) external {
        if (interval < MIN_INTERVAL)   revert InvalidInterval();
        if (destination == address(0)) revert DestinationRequired();
        if (amount == 0)               revert InvalidAmount();
        _getIdx(msg.sender, bucketId);
        scheduledSends[msg.sender][bucketId] = ScheduledSend({
            amount:      amount,
            interval:    interval,
            nextSendAt:  uint64(block.timestamp + interval),
            destination: destination,
            active:      true
        });
        emit ScheduledSendSet(msg.sender, bucketId);
    }

    function cancelScheduledSend(uint256 bucketId) external {
        scheduledSends[msg.sender][bucketId].active = false;
        emit ScheduledSendCancelled(msg.sender, bucketId);
    }

    function executeScheduledSend(address user, uint256 bucketId) external nonReentrant {
        if (msg.sender != scheduler) revert NotScheduler();
        ScheduledSend storage s = scheduledSends[user][bucketId];
        if (!s.active)                      revert BucketNotFound();
        // Intentional timestamp comparison: Arc's ~0.48s blocks make manipulation
        // negligible against the 1-day minimum schedule interval.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < s.nextSendAt) revert TooEarly();
        uint256 idx       = _getIdx(user, bucketId);
        Bucket  storage b = userBuckets[user][idx];
        // Timer advances BEFORE the balance check — by design (PRD §6 audit note):
        // "Advance timer regardless — skip if insufficient, never block the schedule."
        // No on-chain ScheduledSendSkipped event is emitted (not in PRD spec); the off-chain
        // cron service detects a skipped cycle by the absence of a ScheduledSendExecuted event
        // for this (user, bucketId) pair. The cron logs the miss and continues normally.
        // Reverting the timer advance on insufficient balance would allow infinite retry loops
        // that could permanently block the user's schedule — that is the bug this avoids.
        s.nextSendAt = uint64(block.timestamp + s.interval);
        if (b.balance < s.amount) return; // skip cycle — cron detects via missing event
        b.balance -= s.amount;
        USDC.safeTransfer(s.destination, s.amount);
        emit ScheduledSendExecuted(user, bucketId, s.amount, s.destination);
    }

    // ─── Views ────────────────────────────────────────────────────────────

    function getBuckets(address user) external view returns (Bucket[] memory) {
        return userBuckets[user];
    }

    function getScheduledSend(address user, uint256 bucketId) external view returns (ScheduledSend memory) {
        return scheduledSends[user][bucketId];
    }

    function totalBPS(address user) external view returns (uint256) {
        return _sumBPS(user);
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _getIdx(address user, uint256 bucketId) internal view returns (uint256) {
        Bucket[] storage arr = userBuckets[user];
        for (uint256 i = 0; i < arr.length; ) {
            if (arr[i].id == bucketId && arr[i].active) return i;
            unchecked { i++; }
        }
        revert BucketNotFound();
    }

    function _sumBPS(address user) internal view returns (uint256 total) {
        Bucket[] storage arr = userBuckets[user];
        for (uint256 i = 0; i < arr.length; ) {
            if (arr[i].active) total += arr[i].bps;
            unchecked { i++; }
        }
    }

    function _sumBPSExcluding(address user, uint256 excludeId) internal view returns (uint256 total) {
        Bucket[] storage arr = userBuckets[user];
        for (uint256 i = 0; i < arr.length; ) {
            if (arr[i].active && arr[i].id != excludeId) total += arr[i].bps;
            unchecked { i++; }
        }
    }
}
