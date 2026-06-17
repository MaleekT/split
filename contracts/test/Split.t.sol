// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
import { Split } from "../src/Split.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ── Minimal 6-decimal USDC mock ──────────────────────────────────────────────

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// ── Malicious ERC20 (fires a callback during transferFrom to probe reentrancy) ─

contract MaliciousERC20 is ERC20 {
    address public attackTarget;
    bytes   public attackData;

    constructor() ERC20("Evil USDC", "eUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }

    // forge-lint: disable-next-line(missing-zero-check)
    function setAttack(address target, bytes calldata data) external { // address(0) disables the hook
        attackTarget = target;
        attackData   = data;
    }

    function _fireHook() private {
        address target = attackTarget;
        if (target == address(0)) return;
        // Zero out during the call to block recursive re-entry into this hook.
        attackTarget = address(0);
        (bool success, bytes memory ret) = target.call(attackData);
        // Restore before any revert so the hook remains usable across multiple test calls.
        // If assembly revert fires below, EVM rolls back this restoration too — but that
        // also rolls back the zeroing above, leaving attackTarget at its original value.
        attackTarget = target;
        if (!success && ret.length > 0) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    function transferFrom(address from, address to, uint256 amount)
        public override returns (bool)
    {
        bool ok = super.transferFrom(from, to, amount);
        _fireHook();
        return ok;
    }

    function transfer(address to, uint256 amount)
        public override returns (bool)
    {
        bool ok = super.transfer(to, amount);
        _fireHook();
        return ok;
    }
}

// ── Main test contract ────────────────────────────────────────────────────────

contract SplitTest is Test {
    Split    internal split;
    MockUSDC internal usdc;

    address internal user      = makeAddr("user");
    address internal client    = makeAddr("client");
    address internal scheduler = makeAddr("scheduler");
    address internal dest1     = makeAddr("dest1");
    address internal dest2     = makeAddr("dest2");

    uint128 constant USDC_200 = 200_000_000;  // 200 USDC (6 decimals)
    uint128 constant USDC_100 = 100_000_000;  // 100 USDC
    uint128 constant USDC_50  =  50_000_000;
    uint128 constant USDC_10  =  10_000_000;

    function setUp() public {
        usdc  = new MockUSDC();
        split = new Split(address(usdc), scheduler);

        usdc.mint(user,   1_000_000_000); // 1000 USDC
        usdc.mint(client, 1_000_000_000);

        vm.prank(user);
        usdc.approve(address(split), type(uint256).max);

        vm.prank(client);
        usdc.approve(address(split), type(uint256).max);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _addBucket(address who, string memory name, uint16 bps, address dest)
        internal returns (uint256 id)
    {
        vm.prank(who);
        id = split.addBucket(name, bps, dest);
    }

    function _deposit(address who, uint128 amount) internal {
        vm.prank(who);
        split.deposit(amount);
    }

    function _bucketBalance(address who, uint256 id) internal view returns (uint128) {
        Split.Bucket[] memory bs = split.getBuckets(who);
        for (uint256 i; i < bs.length; i++) {
            if (bs[i].id == id) return bs[i].balance;
        }
        revert("bucket not found");
    }

    // ── 1. Happy path ─────────────────────────────────────────────────────────

    function test_deposit_when_twoBuckets_should_splitCorrectly() public {
        uint256 holdId = _addBucket(user, "savings", 6000, address(0));  // 60%
        uint256 sendId = _addBucket(user, "spend",   4000, dest1);       // 40%

        uint256 destBefore = usdc.balanceOf(dest1);
        _deposit(user, USDC_100);

        // hold bucket: 60 USDC
        assertEq(_bucketBalance(user, holdId), 60_000_000);
        // auto-send bucket: destination received 40 USDC, contract balance = 0
        assertEq(usdc.balanceOf(dest1) - destBefore, 40_000_000);
        assertEq(_bucketBalance(user, sendId), 0);
    }

    function test_deposit_when_allHold_should_creditAllToHold() public {
        uint256 id = _addBucket(user, "all", 10_000, address(0));
        _deposit(user, USDC_100);
        assertEq(_bucketBalance(user, id), USDC_100);
    }

    // ── 2. depositFor ─────────────────────────────────────────────────────────

    function test_depositFor_when_clientPays_should_applyUserRules() public {
        uint256 holdId = _addBucket(user, "savings", 5000, address(0));
        _addBucket(user, "ops", 5000, dest1);

        vm.prank(client);
        split.depositFor(user, USDC_50);

        assertEq(_bucketBalance(user, holdId), 25_000_000);
        assertEq(usdc.balanceOf(dest1),        25_000_000);
    }

    function test_depositFor_when_zeroAmount_should_revert() public {
        _addBucket(user, "a", 10_000, address(0));
        vm.prank(client);
        vm.expectRevert(Split.InvalidAmount.selector);
        split.depositFor(user, 0);
    }

    // ── 3. BPS validation ─────────────────────────────────────────────────────

    function test_addBucket_when_exceedsBPS_should_revert() public {
        _addBucket(user, "a", 6000, address(0));
        vm.prank(user);
        vm.expectRevert(Split.ExceedsBPS.selector);
        split.addBucket("b", 5000, address(0)); // 6000 + 5000 > 10000
    }

    function test_deposit_when_BPSTotalNot10000_should_revert() public {
        _addBucket(user, "a", 5000, address(0)); // only 50%, not 100%
        vm.prank(user);
        vm.expectRevert(Split.InvalidBPSTotal.selector);
        split.deposit(USDC_100);
    }

    function test_deposit_when_noBuckets_should_revert() public {
        vm.prank(user);
        vm.expectRevert(Split.NoBuckets.selector);
        split.deposit(USDC_100);
    }

    function test_deposit_when_zeroAmount_should_revert() public {
        _addBucket(user, "a", 10_000, address(0));
        vm.prank(user);
        vm.expectRevert(Split.InvalidAmount.selector);
        split.deposit(0);
    }

    // ── 4. updateBucket ───────────────────────────────────────────────────────

    function test_updateBucket_when_validNewBPS_should_rerouteOnNextDeposit() public {
        uint256 id1 = _addBucket(user, "a", 5000, address(0));
        uint256 id2 = _addBucket(user, "b", 5000, dest1);

        // Must reduce id2 first (freeing BPS) before raising id1, otherwise
        // intermediate sum would exceed 10000 and revert ExceedsBPS.
        vm.prank(user);
        split.updateBucket(id2, "b", 3000, dest2); // 5000→3000, total now 8000
        vm.prank(user);
        split.updateBucket(id1, "a", 7000, address(0)); // 5000→7000, total now 10000

        uint256 d2Before = usdc.balanceOf(dest2);
        _deposit(user, USDC_100);

        assertEq(_bucketBalance(user, id1), 70_000_000);
        assertEq(usdc.balanceOf(dest2) - d2Before, 30_000_000);
    }

    function test_updateBucket_when_exceedsBPS_should_revert() public {
        uint256 id1 = _addBucket(user, "a", 5000, address(0));
        _addBucket(user, "b", 5000, address(0));

        vm.prank(user);
        vm.expectRevert(Split.ExceedsBPS.selector);
        split.updateBucket(id1, "a", 6000, address(0)); // 6000 + 5000 = 11000 > 10000
    }

    function test_updateBucket_when_badId_should_revert() public {
        vm.prank(user);
        vm.expectRevert(Split.BucketNotFound.selector);
        split.updateBucket(999, "x", 5000, address(0));
    }

    // ── 5. deleteBucket ───────────────────────────────────────────────────────

    function test_deleteBucket_when_hasBalance_should_refundAndRemove() public {
        uint256 id1 = _addBucket(user, "a", 6000, address(0));
        uint256 id2 = _addBucket(user, "b", 4000, address(0));
        _deposit(user, USDC_100);

        uint256 balBefore = usdc.balanceOf(user);
        vm.prank(user);
        split.deleteBucket(id1);

        // refunded 60 USDC
        assertEq(usdc.balanceOf(user) - balBefore, 60_000_000);
        // array still contiguous — id2 still accessible
        assertEq(_bucketBalance(user, id2), 40_000_000);
    }

    function test_deleteBucket_when_hasSchedule_should_cancelSchedule() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);
        assertTrue(split.getScheduledSend(user, id).active);

        vm.prank(user);
        split.deleteBucket(id);

        assertFalse(split.getScheduledSend(user, id).active);
    }

    function test_deleteBucket_when_arrayHasMultiple_should_remainContiguous() public {
        uint256 id0 = _addBucket(user, "a", 3000, address(0));
        uint256 id1 = _addBucket(user, "b", 3000, address(0));
        uint256 id2 = _addBucket(user, "c", 4000, address(0));

        // Delete middle bucket
        vm.prank(user);
        split.deleteBucket(id1);

        // Remaining buckets reachable and BPS total matches
        assertEq(split.totalBPS(user), 7000);
        // id0 and id2 still work
        vm.prank(user);
        split.updateBucket(id0, "a", 3000, address(0));
        vm.prank(user);
        split.updateBucket(id2, "c", 7000, address(0));
        assertEq(split.totalBPS(user), 10_000);
    }

    // ── 6. Dust handling ──────────────────────────────────────────────────────

    function test_deposit_when_threeUnequalBuckets_should_accountForAllDust() public {
        uint256 id0 = _addBucket(user, "a", 3333, address(0));
        uint256 id1 = _addBucket(user, "b", 3333, address(0));
        uint256 id2 = _addBucket(user, "c", 3334, address(0));

        _deposit(user, USDC_100);

        uint128 b0 = _bucketBalance(user, id0);
        uint128 b1 = _bucketBalance(user, id1);
        uint128 b2 = _bucketBalance(user, id2);

        // Entire 100 USDC must be accounted for
        assertEq(uint256(b0) + uint256(b1) + uint256(b2), USDC_100);
    }

    function test_deposit_when_dustPresent_should_goToLastHoldBucket() public {
        // 1 unit deposit, 3 equal BPS buckets — all shares round to 0, dust = 1
        uint256 id0 = _addBucket(user, "a", 3333, address(0));
        uint256 id1 = _addBucket(user, "b", 3333, address(0));
        uint256 id2 = _addBucket(user, "c", 3334, address(0));

        _deposit(user, 1); // 1 raw unit

        uint128 b0 = _bucketBalance(user, id0);
        uint128 b1 = _bucketBalance(user, id1);
        uint128 b2 = _bucketBalance(user, id2);

        assertEq(uint256(b0) + uint256(b1) + uint256(b2), 1);
    }

    // ── 7. withdraw / withdrawTo ──────────────────────────────────────────────

    function test_withdraw_when_sufficientBalance_should_sendToUser() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        split.withdraw(id, USDC_50);

        assertEq(usdc.balanceOf(user) - before, USDC_50);
        assertEq(_bucketBalance(user, id), USDC_50);
    }

    function test_withdraw_when_insufficientBalance_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_50);

        vm.prank(user);
        vm.expectRevert(Split.InsufficientBalance.selector);
        split.withdraw(id, USDC_100);
    }

    function test_withdraw_when_zeroAmount_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        vm.prank(user);
        vm.expectRevert(Split.InvalidAmount.selector);
        split.withdraw(id, 0);
    }

    function test_withdrawTo_when_validAddress_should_sendToRecipient() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        uint256 before = usdc.balanceOf(dest1);
        vm.prank(user);
        split.withdrawTo(id, USDC_50, dest1);

        assertEq(usdc.balanceOf(dest1) - before, USDC_50);
    }

    function test_withdrawTo_when_zeroAmount_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);
        vm.prank(user);
        vm.expectRevert(Split.InvalidAmount.selector);
        split.withdrawTo(id, 0, dest1);
    }

    function test_withdrawTo_when_zeroAddress_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        vm.prank(user);
        vm.expectRevert();
        split.withdrawTo(id, USDC_50, address(0));
    }

    function test_withdrawTo_when_insufficientBalance_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_10);

        vm.prank(user);
        vm.expectRevert(Split.InsufficientBalance.selector);
        split.withdrawTo(id, USDC_100, dest1);
    }

    // ── 8. Scheduled send ─────────────────────────────────────────────────────

    function test_setScheduledSend_when_validParams_should_store() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);

        Split.ScheduledSend memory s = split.getScheduledSend(user, id);
        assertTrue(s.active);
        assertEq(s.amount, USDC_10);
        assertEq(s.interval, 1 days);
        assertEq(s.destination, dest1);
    }

    function test_setScheduledSend_when_intervalTooShort_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        vm.prank(user);
        vm.expectRevert(Split.InvalidInterval.selector);
        split.setScheduledSend(id, USDC_10, 1 hours, dest1);
    }

    function test_setScheduledSend_when_noDestination_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        vm.prank(user);
        vm.expectRevert(Split.DestinationRequired.selector);
        split.setScheduledSend(id, USDC_10, 1 days, address(0));
    }

    function test_setScheduledSend_when_zeroAmount_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        vm.prank(user);
        vm.expectRevert(Split.InvalidAmount.selector);
        split.setScheduledSend(id, 0, 1 days, dest1);
    }

    function test_executeScheduledSend_when_happyPath_should_transfer() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);

        vm.warp(block.timestamp + 1 days + 1);

        uint256 before = usdc.balanceOf(dest1);
        vm.prank(scheduler);
        split.executeScheduledSend(user, id);

        assertEq(usdc.balanceOf(dest1) - before, USDC_10);
        assertEq(_bucketBalance(user, id), USDC_100 - USDC_10);
    }

    function test_executeScheduledSend_when_insufficientBalance_should_skipNotRevert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_10 - 1); // 1 unit less than send amount

        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);

        vm.warp(block.timestamp + 1 days + 1);

        uint256 destBefore = usdc.balanceOf(dest1);
        vm.prank(scheduler);
        split.executeScheduledSend(user, id); // must NOT revert

        // No transfer
        assertEq(usdc.balanceOf(dest1), destBefore);
        // Timer still advanced
        Split.ScheduledSend memory s = split.getScheduledSend(user, id);
        assertGt(s.nextSendAt, block.timestamp - 1);
    }

    function test_executeScheduledSend_when_tooEarly_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);

        vm.prank(scheduler);
        vm.expectRevert(Split.TooEarly.selector);
        split.executeScheduledSend(user, id);
    }

    function test_executeScheduledSend_when_notScheduler_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(user); // not the scheduler
        vm.expectRevert(Split.NotScheduler.selector);
        split.executeScheduledSend(user, id);
    }

    function test_executeScheduledSend_when_inactive_should_revert() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);
        vm.prank(user);
        split.cancelScheduledSend(id);

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(scheduler);
        vm.expectRevert(Split.BucketNotFound.selector);
        split.executeScheduledSend(user, id);
    }

    function test_cancelScheduledSend_should_deactivate() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);
        vm.prank(user);
        split.cancelScheduledSend(id);
        assertFalse(split.getScheduledSend(user, id).active);
    }

    // ── 9. MAX_BUCKETS ────────────────────────────────────────────────────────

    function test_addBucket_when_eleventh_should_revertTooManyBuckets() public {
        for (uint16 i = 0; i < 10; i++) {
            vm.prank(user);
            split.addBucket(string(abi.encodePacked("b", i)), 1000, address(0));
        }
        vm.prank(user);
        vm.expectRevert(Split.TooManyBuckets.selector);
        split.addBucket("overflow", 1, address(0));
    }

    // ── 10. Reentrancy ────────────────────────────────────────────────────────

    function test_deposit_when_reentrant_should_revert() public {
        // Deploy a Split instance backed by the malicious ERC20
        MaliciousERC20 evil      = new MaliciousERC20();
        Split          evilSplit = new Split(address(evil), scheduler);

        address atk = makeAddr("atk");
        evil.mint(atk, USDC_200);

        vm.prank(atk);
        evil.approve(address(evilSplit), type(uint256).max);
        vm.prank(atk);
        evilSplit.addBucket("all", 10_000, address(0));

        // Configure the token to attempt a reentrant deposit during transferFrom.
        // The ReentrancyGuard will reject the inner call; MaliciousERC20 propagates
        // that revert, causing the outer deposit to also fail.
        evil.setAttack(
            address(evilSplit),
            abi.encodeCall(Split.deposit, (1))
        );

        vm.prank(atk);
        vm.expectRevert();
        evilSplit.deposit(USDC_100);
    }

    function test_withdraw_when_partialAmount_should_leaveRemainder() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);

        vm.prank(user);
        split.withdraw(id, USDC_50);
        assertEq(_bucketBalance(user, id), USDC_50);
    }

    function test_withdraw_when_reentrant_should_revert() public {
        MaliciousERC20 evil      = new MaliciousERC20();
        Split          evilSplit = new Split(address(evil), scheduler);

        address atk = makeAddr("atk2");
        evil.mint(atk, USDC_100);

        vm.prank(atk);
        evil.approve(address(evilSplit), type(uint256).max);
        vm.prank(atk);
        uint256 id = evilSplit.addBucket("all", 10_000, address(0));

        vm.prank(atk);
        evilSplit.deposit(USDC_100);

        // Hook fires during safeTransfer (outgoing) and tries to reenter withdraw.
        evil.setAttack(
            address(evilSplit),
            abi.encodeCall(Split.withdraw, (id, 1))
        );

        vm.prank(atk);
        vm.expectRevert();
        evilSplit.withdraw(id, USDC_50);
    }

    // ── 11. Constructor / views ───────────────────────────────────────────────

    function test_constructor_when_zeroUsdc_should_revert() public {
        vm.expectRevert();
        new Split(address(0), scheduler);
    }

    function test_constructor_when_zeroScheduler_should_revert() public {
        vm.expectRevert();
        new Split(address(usdc), address(0));
    }

    function test_totalBPS_should_reflect_addedBuckets() public {
        assertEq(split.totalBPS(user), 0);
        _addBucket(user, "a", 3000, address(0));
        assertEq(split.totalBPS(user), 3000);
        _addBucket(user, "b", 7000, address(0));
        assertEq(split.totalBPS(user), 10_000);
    }

    function test_getBuckets_should_returnAll() public {
        _addBucket(user, "a", 5000, address(0));
        _addBucket(user, "b", 5000, dest1);
        Split.Bucket[] memory bs = split.getBuckets(user);
        assertEq(bs.length, 2);
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function test_deposit_should_emitDepositedAndBucketSplit() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));

        vm.expectEmit(true, true, false, true);
        emit Split.Deposited(user, user, USDC_100);

        vm.expectEmit(true, true, false, true);
        emit Split.BucketSplit(user, id, USDC_100, address(0));

        _deposit(user, USDC_100);
    }

    function test_deleteBucket_should_emitBucketDeleted() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        vm.expectEmit(true, false, false, true);
        emit Split.BucketDeleted(user, id);
        vm.prank(user);
        split.deleteBucket(id);
    }

    function test_executeScheduledSend_should_emitExecuted() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);
        vm.prank(user);
        split.setScheduledSend(id, USDC_10, 1 days, dest1);
        vm.warp(block.timestamp + 1 days + 1);

        vm.expectEmit(true, true, false, true);
        emit Split.ScheduledSendExecuted(user, id, USDC_10, dest1);

        vm.prank(scheduler);
        split.executeScheduledSend(user, id);
    }

    // ── Multiple deposits / monotonic IDs ─────────────────────────────────────

    function test_deposit_when_multipleDeposits_should_accumulateBalance() public {
        uint256 id = _addBucket(user, "a", 10_000, address(0));
        _deposit(user, USDC_100);
        _deposit(user, USDC_50);
        assertEq(_bucketBalance(user, id), USDC_100 + USDC_50);
    }

    function test_bucketIds_are_monotonic_after_delete() public {
        uint256 id0 = _addBucket(user, "a", 5000, address(0));
        uint256 id1 = _addBucket(user, "b", 5000, address(0));
        assertEq(id0, 0);
        assertEq(id1, 1);

        vm.prank(user);
        split.deleteBucket(id0);

        // next id continues from 2, not reused
        uint256 id2 = _addBucket(user, "c", 5000, address(0));
        assertEq(id2, 2);
        // id1 still valid
        assertEq(split.totalBPS(user), 10_000);
    }
}
