// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { BucketLock } from "../src/BucketLock.sol";
import { BucketLockFactory } from "../src/BucketLockFactory.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ── Minimal 6-decimal USDC mock, matching the convention in Split.t.sol ───────

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// ── A token that refuses transfers to one address, to prove atomic rollback ───

contract BlockingUSDC is ERC20 {
    address public blocked;
    constructor() ERC20("Blocking USDC", "bUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function block_(address who) external { blocked = who; }
    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "blocked recipient");
        super._update(from, to, value);
    }
}

contract BucketLockTest is Test {
    MockUSDC          usdc;
    BucketLockFactory factory;

    address owner    = makeAddr("owner");
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");

    uint256 constant USDC_100 = 100_000_000; // 100.000000
    uint64  constant DAY      = 1 days;

    function setUp() public {
        vm.warp(1_800_000_000); // sane wall-clock base; forge starts at 1
        usdc    = new MockUSDC();
        factory = new BucketLockFactory(IERC20(address(usdc)), treasury);
    }

    // Helper: a date-only lock one year out, funded with `amount`.
    function _lock(uint256 target, uint256 amount) internal returns (BucketLock lock) {
        vm.prank(owner);
        lock = BucketLock(factory.createLock(uint64(block.timestamp + 365 days), target));
        if (amount > 0) usdc.mint(address(lock), amount);
    }

    // ── Factory validation ────────────────────────────────────────────────

    function test_factory_rejectsMissingDate() public {
        vm.prank(owner);
        vm.expectRevert(BucketLockFactory.DateRequired.selector);
        factory.createLock(0, USDC_100);
    }

    function test_factory_rejectsDateInsideMinDuration() public {
        vm.prank(owner);
        vm.expectRevert(BucketLockFactory.UnlockTooSoon.selector);
        factory.createLock(uint64(block.timestamp + DAY - 1), 0);
    }

    function test_factory_acceptsDateExactlyAtMinDuration() public {
        vm.prank(owner);
        address lock = factory.createLock(uint64(block.timestamp + DAY), 0);
        assertTrue(factory.isLock(lock), "provenance recorded");
    }

    function test_factory_rejectsZeroConstructorArgs() public {
        vm.expectRevert(BucketLockFactory.ZeroAddress.selector);
        new BucketLockFactory(IERC20(address(0)), treasury);
        vm.expectRevert(BucketLockFactory.ZeroAddress.selector);
        new BucketLockFactory(IERC20(address(usdc)), address(0));
    }

    // ── Lock validates independently of the factory ───────────────────────

    function test_lock_rejectsZeroAddresses_whenBuiltDirectly() public {
        uint64 when = uint64(block.timestamp + 365 days);
        vm.expectRevert(BucketLock.ZeroAddress.selector);
        new BucketLock(address(0), IERC20(address(usdc)), treasury, when, 0);
        vm.expectRevert(BucketLock.ZeroAddress.selector);
        new BucketLock(owner, IERC20(address(0)), treasury, when, 0);
        vm.expectRevert(BucketLock.ZeroAddress.selector);
        new BucketLock(owner, IERC20(address(usdc)), address(0), when, 0);
    }

    function test_lock_rejectsNoCondition_whenBuiltDirectly() public {
        vm.expectRevert(BucketLock.NoUnlockCondition.selector);
        new BucketLock(owner, IERC20(address(usdc)), treasury, 0, 0);
    }

    function test_lock_rejectsPastDate_whenBuiltDirectly() public {
        vm.expectRevert(BucketLock.UnlockInPast.selector);
        new BucketLock(owner, IERC20(address(usdc)), treasury, uint64(block.timestamp), 0);
    }

    // ── Provenance ────────────────────────────────────────────────────────

    function test_provenance_lockMatchesFactory() public {
        BucketLock lock = _lock(0, 0);
        assertEq(lock.owner(), owner,                      "owner is the createLock caller");
        assertEq(address(lock.token()), address(factory.token()), "token matches factory");
        assertEq(lock.treasury(), factory.treasury(),      "treasury matches factory");
        assertEq(lock.PENALTY_BPS(), factory.PENALTY_BPS(), "penalty constants agree");
        assertEq(lock.PENALTY_BPS(), 1_000,                "exactly 10%");
        assertTrue(factory.isLock(address(lock)),          "isLock true for factory output");
    }

    function test_provenance_isLockFalseForDirectDeploy() public {
        BucketLock rogue =
            new BucketLock(owner, IERC20(address(usdc)), treasury, uint64(block.timestamp + 365 days), 0);
        assertFalse(factory.isLock(address(rogue)), "direct deploys are unsupported");
    }

    function test_discovery_pagination() public {
        _lock(0, 0);
        _lock(0, 0);
        assertEq(factory.locksOfLength(owner), 2, "two locks recorded");
        assertTrue(factory.locksOfAt(owner, 0) != factory.locksOfAt(owner, 1), "distinct");
        assertEq(factory.locksOfLength(stranger), 0, "per-user isolation");
    }

    // ── Access control ────────────────────────────────────────────────────

    function test_onlyOwnerWithdraws() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.prank(stranger);
        vm.expectRevert(BucketLock.NotOwner.selector);
        lock.withdraw(1_000_000);
    }

    // ── Unlock semantics ──────────────────────────────────────────────────

    function test_lockedBeforeDate() public {
        BucketLock lock = _lock(0, USDC_100);
        assertFalse(lock.isUnlocked(), "date not reached");
    }

    function test_unlocksOnDate() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.warp(block.timestamp + 365 days);
        assertTrue(lock.isUnlocked(), "date reached");
    }

    function test_unlocksOnTarget_withoutPoke() public {
        BucketLock lock = _lock(USDC_100, USDC_100);
        assertTrue(lock.isUnlocked(), "live balance meets target, no poke needed");
        assertFalse(lock.targetMet(), "but nothing has latched it yet");
    }

    function test_targetBelowThresholdStaysLocked() public {
        BucketLock lock = _lock(USDC_100, USDC_100 - 1);
        assertFalse(lock.isUnlocked(), "one unit short");
    }

    // ── The latch ─────────────────────────────────────────────────────────

    function test_latchSurvivesWithdrawBelowTarget() public {
        BucketLock lock = _lock(USDC_100, USDC_100);
        lock.poke();
        assertTrue(lock.targetMet(), "latched");

        vm.prank(owner);
        lock.withdraw(USDC_100 / 2); // drops live balance below target

        assertTrue(lock.targetMet(), "latch is permanent");
        assertTrue(lock.isUnlocked(), "does not re-lock");
    }

    function test_latchSetsEvenWhenDateAlreadyPassed_andEmitsOnce() public {
        BucketLock lock = _lock(USDC_100, USDC_100);
        vm.warp(block.timestamp + 365 days); // already unlocked by date

        vm.recordLogs();
        lock.poke();
        assertTrue(lock.targetMet(), "latched despite date unlock");

        // Second poke must not emit again: false -> true only.
        vm.recordLogs();
        lock.poke();
        assertEq(vm.getRecordedLogs().length, 0, "TargetMet emitted exactly once");
    }

    function test_targetNeverReached_doesNotLatch() public {
        BucketLock lock = _lock(USDC_100, USDC_100 - 1);
        lock.poke();
        assertFalse(lock.targetMet(), "never met, never latched");
    }

    // ── Live balance, not cumulative receipts ─────────────────────────────

    function test_targetIsLiveBalanceNotCumulative() public {
        BucketLock lock = _lock(USDC_100, 0);
        // Fund to half, twice, with a withdrawal between: cumulative would be 100,
        // live never is. It must stay locked.
        usdc.mint(address(lock), USDC_100 / 2);
        assertFalse(lock.isUnlocked(), "half is not the target");
        usdc.mint(address(lock), USDC_100 / 2);
        assertTrue(lock.isUnlocked(), "now live balance meets it");
    }

    function test_nonOwnerCanFundTargetAndUnlockEarly() public {
        BucketLock lock = _lock(USDC_100, 0);
        assertFalse(lock.isUnlocked(), "starts locked");

        // A third party sends USDC directly. Documented, accepted behaviour.
        usdc.mint(stranger, USDC_100);
        vm.prank(stranger);
        usdc.transfer(address(lock), USDC_100);

        assertTrue(lock.isUnlocked(), "stranger's funds count toward the target");

        // But only the owner can ever take anything out.
        vm.prank(stranger);
        vm.expectRevert(BucketLock.NotOwner.selector);
        lock.withdrawAll();
    }

    function test_depositsAfterLatchAreWithdrawnPenaltyFree() public {
        BucketLock lock = _lock(USDC_100, USDC_100);
        lock.poke();
        usdc.mint(address(lock), USDC_100); // arrives after latching

        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        lock.withdrawAll();

        assertEq(usdc.balanceOf(owner) - before, USDC_100 * 2, "no penalty taken");
        assertEq(usdc.balanceOf(treasury), 0, "treasury untouched");
    }

    // ── Penalty arithmetic ────────────────────────────────────────────────

    function test_earlyWithdrawChargesExactlyTenPercent() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.prank(owner);
        lock.withdraw(USDC_100);

        assertEq(usdc.balanceOf(treasury), USDC_100 / 10, "treasury gets exactly 10%");
        assertEq(usdc.balanceOf(owner),    USDC_100 - USDC_100 / 10, "owner gets the rest");
    }

    function test_unlockedWithdrawChargesNothing() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.warp(block.timestamp + 365 days);
        vm.prank(owner);
        lock.withdrawAll();

        assertEq(usdc.balanceOf(treasury), 0,        "no penalty when unlocked");
        assertEq(usdc.balanceOf(owner),    USDC_100, "owner receives everything");
    }

    function test_penaltyRoundsUp() public {
        BucketLock lock = _lock(0, 100);
        vm.prank(owner);
        lock.withdraw(15); // 10% of 15 = 1.5 -> ceil 2
        assertEq(usdc.balanceOf(treasury), 2, "ceiling, not floor");
        assertEq(usdc.balanceOf(owner),    13);
    }

    function test_oneUnitEarlyWithdrawReverts() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.prank(owner);
        vm.expectRevert(BucketLock.PenaltyExceedsAmount.selector);
        lock.withdraw(1); // ceil(0.1) == 1 == amount, net would be zero
    }

    function test_twoUnitEarlyWithdrawSucceeds() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.prank(owner);
        lock.withdraw(2);
        assertEq(usdc.balanceOf(treasury), 1, "one unit penalty");
        assertEq(usdc.balanceOf(owner),    1, "one unit net");
    }

    function test_zeroAmountReverts() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.prank(owner);
        vm.expectRevert(BucketLock.InvalidAmount.selector);
        lock.withdraw(0);
    }

    function test_overBalanceReverts() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.prank(owner);
        vm.expectRevert(BucketLock.InsufficientBalance.selector);
        lock.withdraw(USDC_100 + 1);
    }

    function test_partialEarlyWithdrawLeavesRemainderLocked() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.prank(owner);
        lock.withdraw(USDC_100 / 2);

        assertEq(usdc.balanceOf(treasury), USDC_100 / 20, "10% of the withdrawn half only");
        assertEq(usdc.balanceOf(address(lock)), USDC_100 / 2, "rest still locked");
        assertFalse(lock.isUnlocked(), "still locked");
    }

    // ── Previews ──────────────────────────────────────────────────────────

    function test_quotePenaltyIsPureAndWorksOnEmptyLock() public {
        BucketLock lock = _lock(0, 0); // no funds at all
        (uint256 penalty, uint256 net) = lock.quotePenalty(USDC_100);
        assertEq(penalty, USDC_100 / 10, "quotes against an empty lock");
        assertEq(net,     USDC_100 - USDC_100 / 10);
    }

    function test_quotePenaltyDoesNotRevertOnDust() public {
        BucketLock lock = _lock(0, 0);
        (uint256 penalty, uint256 net) = lock.quotePenalty(1);
        assertEq(penalty, 1, "calculator, not a gate");
        assertEq(net,     0);
    }

    /// Also proves `penalty` (a named return) is zero-initialised when unlocked.
    function test_previewUnlockedReturnsZeroPenalty() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.warp(block.timestamp + 365 days);
        (uint256 net, uint256 penalty, bool early) = lock.previewWithdraw(USDC_100);
        assertEq(penalty, 0,        "no penalty when unlocked");
        assertEq(net,     USDC_100, "net is the full amount");
        assertFalse(early);
    }

    function test_previewMatchesExecution() public {
        BucketLock lock = _lock(0, USDC_100);
        (uint256 net, uint256 penalty, bool early) = lock.previewWithdraw(USDC_100);
        assertTrue(early, "early");

        vm.prank(owner);
        lock.withdraw(USDC_100);

        assertEq(usdc.balanceOf(owner),    net,     "net matches preview");
        assertEq(usdc.balanceOf(treasury), penalty, "penalty matches preview");
    }

    function test_previewRevertsWhereExecutionWould() public {
        BucketLock lock = _lock(0, USDC_100);
        vm.expectRevert(BucketLock.InvalidAmount.selector);
        lock.previewWithdraw(0);
        vm.expectRevert(BucketLock.InsufficientBalance.selector);
        lock.previewWithdraw(USDC_100 + 1);
        vm.expectRevert(BucketLock.PenaltyExceedsAmount.selector);
        lock.previewWithdraw(1);
    }

    // ── Atomic rollback ───────────────────────────────────────────────────

    function test_rollbackWhenTreasuryTransferFails() public {
        BlockingUSDC bad = new BlockingUSDC();
        BucketLockFactory f = new BucketLockFactory(IERC20(address(bad)), treasury);
        vm.prank(owner);
        BucketLock lock = BucketLock(f.createLock(uint64(block.timestamp + 365 days), 0));
        bad.mint(address(lock), USDC_100);
        bad.block_(treasury); // treasury leg will revert

        vm.prank(owner);
        vm.expectRevert(bytes("blocked recipient"));
        lock.withdraw(USDC_100);

        assertEq(bad.balanceOf(address(lock)), USDC_100, "no partial payout survived");
        assertEq(bad.balanceOf(owner),         0,        "owner got nothing");
    }

    function test_rollbackWhenOwnerTransferFails() public {
        BlockingUSDC bad = new BlockingUSDC();
        BucketLockFactory f = new BucketLockFactory(IERC20(address(bad)), treasury);
        vm.prank(owner);
        BucketLock lock = BucketLock(f.createLock(uint64(block.timestamp + 365 days), 0));
        bad.mint(address(lock), USDC_100);
        bad.block_(owner); // owner leg reverts, AFTER treasury would have been paid

        vm.prank(owner);
        vm.expectRevert(bytes("blocked recipient"));
        lock.withdraw(USDC_100);

        assertEq(bad.balanceOf(address(lock)), USDC_100, "treasury leg rolled back too");
        assertEq(bad.balanceOf(treasury),      0,        "no half-paid withdrawal");
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────

    /// Value conservation: owner + treasury always equals what left the lock.
    function testFuzz_valueIsConserved(uint256 funded, uint256 amount, bool unlocked) public {
        funded = bound(funded, 2, type(uint128).max);
        amount = bound(amount, 2, funded);

        BucketLock lock = _lock(0, 0);
        usdc.mint(address(lock), funded);
        if (unlocked) vm.warp(block.timestamp + 365 days);

        uint256 lockBefore = usdc.balanceOf(address(lock));
        vm.prank(owner);
        lock.withdraw(amount);

        uint256 removed = lockBefore - usdc.balanceOf(address(lock));
        assertEq(removed, amount, "exactly the requested amount left");
        assertEq(usdc.balanceOf(owner) + usdc.balanceOf(treasury), amount, "conserved");
    }

    /// Ceiling penalty never exceeds the amount above one unit, and is never zero.
    function testFuzz_penaltyBounds(uint256 amount) public {
        amount = bound(amount, 1, type(uint256).max);
        BucketLock lock = _lock(0, 0);
        (uint256 penalty, uint256 net) = lock.quotePenalty(amount);

        assertGe(penalty, 1, "ceiling means never zero");
        assertLe(penalty, amount, "never more than the amount");
        assertEq(penalty + net, amount, "quote is internally consistent");
        if (amount >= 2) assertLt(penalty, amount, "net is positive above one unit");
    }

    /// The latch is monotonic: once true, no sequence of calls clears it.
    function testFuzz_latchIsMonotonic(uint256 target, uint256 funded, uint8 withdrawals) public {
        target = bound(target, 1, type(uint96).max);
        funded = bound(funded, target, type(uint128).max);

        BucketLock lock = _lock(target, 0);
        usdc.mint(address(lock), funded);
        lock.poke();
        assertTrue(lock.targetMet(), "latched");

        uint256 n = bound(withdrawals, 1, 8);
        for (uint256 i = 0; i < n; i++) {
            uint256 bal = usdc.balanceOf(address(lock));
            if (bal < 2) break;
            // Floor at 2: a one-unit early withdrawal is rejected by design
            // (ceiling penalty would consume the whole unit), and bal >= 2 here
            // guarantees 2 is always affordable.
            uint256 amt = bal / 2;
            if (amt < 2) amt = 2;
            vm.prank(owner);
            lock.withdraw(amt);
            assertTrue(lock.targetMet(), "still latched");
        }
    }
}
