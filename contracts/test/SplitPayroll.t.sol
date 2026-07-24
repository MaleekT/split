// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Split } from "../src/Split.sol";
import { SplitPayroll } from "../src/SplitPayroll.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ── Minimal 6-decimal USDC mock (matches Split.t.sol convention) ──────────────

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// ── Reentrancy probe: fires a callback during transfer/transferFrom ───────────

contract ReentrantUSDC is ERC20 {
    address public attackTarget;
    bytes   public attackData;

    constructor() ERC20("Evil USDC", "eUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function setAttack(address target, bytes calldata data) external {
        attackTarget = target;
        attackData   = data;
    }

    function _fireHook() private {
        address target = attackTarget;
        if (target == address(0)) return;
        attackTarget = address(0); // one-shot: block infinite recursion
        (bool success, bytes memory ret) = target.call(attackData);
        attackTarget = target;
        if (!success && ret.length > 0) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        _fireHook();
        return ok;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        _fireHook();
        return ok;
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

contract SplitPayrollTest is Test {
    Split        internal split;
    SplitPayroll internal payroll;
    MockUSDC     internal usdc;

    address internal employer  = makeAddr("employer");
    address internal scheduler = makeAddr("scheduler");

    uint128 constant USDC_1000 = 1_000_000_000; // 1000 USDC (6 decimals)
    uint128 constant USDC_700  =   700_000_000;
    uint128 constant USDC_600   =  600_000_000;
    uint128 constant USDC_500  =   500_000_000;
    uint128 constant USDC_400  =   400_000_000;
    uint128 constant USDC_100  =   100_000_000;

    // mirror of the contract's outcome codes for readable assertions
    uint8 constant SPLIT_OK  = 0;
    uint8 constant FALLBACK  = 1;
    uint8 constant PLAIN     = 2;

    event PayrollRun(address indexed employer, uint256 runId, uint256 total, uint256 payeeCount);
    event PayrollPayment(address indexed employer, address indexed payee, uint128 amount, uint8 outcome, bytes32 memoHash);

    function setUp() public {
        usdc    = new MockUSDC();
        split   = new Split(address(usdc), scheduler);
        payroll = new SplitPayroll(address(usdc), address(split));

        usdc.mint(employer, 1_000_000_000_000); // 1,000,000 USDC, plenty
        vm.prank(employer);
        usdc.approve(address(payroll), type(uint256).max);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    // Valid Split user: 60% hold bucket + 40% auto-send bucket (sums to 10000).
    function _makeSplitUser(uint160 seed) internal returns (address user, address autoDest) {
        user     = address(uint160(0x100000) + seed);
        autoDest = address(uint160(0x200000) + seed);
        vm.startPrank(user);
        split.addBucket("save",  6000, address(0));  // hold
        split.addBucket("spend", 4000, autoDest);    // auto-send
        vm.stopPrank();
    }

    // Split user with zero buckets -> _split reverts NoBuckets.
    function _makeNoBucketUser(uint160 seed) internal pure returns (address user) {
        user = address(uint160(0x300000) + seed);
    }

    // Split user whose bps sum to 5000 (!= 10000) -> _split reverts InvalidBPSTotal.
    function _makeBadBpsUser(uint160 seed) internal returns (address user) {
        user = address(uint160(0x400000) + seed);
        vm.prank(user);
        split.addBucket("only", 5000, address(0));
    }

    function _plainPayee(uint160 seed) internal pure returns (address) {
        return address(uint160(0x500000) + seed);
    }

    function _p(address dest, uint128 amount, bool isSplit, bytes32 memo)
        internal pure returns (SplitPayroll.Payee memory)
    {
        return SplitPayroll.Payee({ dest: dest, amount: amount, isSplitUser: isSplit, memoHash: memo });
    }

    // ── 1. Happy path: mixed run ────────────────────────────────────────────

    function test_runPayroll_when_mixedRoster_should_routeEachCorrectly() public {
        (address split1, address auto1) = _makeSplitUser(1);
        address plain1 = _plainPayee(1);

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](2);
        ps[0] = _p(split1, USDC_700, true,  bytes32(uint256(0xAA)));
        ps[1] = _p(plain1, USDC_400, false, bytes32(0));

        uint256 empBefore = usdc.balanceOf(employer);

        vm.prank(employer);
        payroll.runPayroll(ps, 42);

        // Split user: 60% held in Split, 40% auto-sent to their destination.
        assertEq(_holdBalance(split1), (uint256(USDC_700) * 6000) / 10000, "hold share");
        assertEq(usdc.balanceOf(auto1), (uint256(USDC_700) * 4000) / 10000, "auto-send share");
        // Plain payee: full amount straight to wallet.
        assertEq(usdc.balanceOf(plain1), USDC_400, "plain amount");
        // Employer paid exactly the run total.
        assertEq(empBefore - usdc.balanceOf(employer), uint256(USDC_700) + USDC_400, "employer debit");
        // Contract holds nothing; allowance to Split cleared.
        assertEq(usdc.balanceOf(address(payroll)), 0, "contract residue");
        assertEq(usdc.allowance(address(payroll), address(split)), 0, "cleared allowance");
    }

    // ── 2. Fallback on NoBuckets ────────────────────────────────────────────

    function test_runPayroll_when_payeeHasNoBuckets_should_fallbackToPlainTransfer() public {
        address broken = _makeNoBucketUser(1);

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = _p(broken, USDC_500, true, bytes32(0)); // marked split, but no buckets

        vm.expectEmit(true, true, false, true, address(payroll));
        emit PayrollPayment(employer, broken, USDC_500, FALLBACK, bytes32(0));

        vm.prank(employer);
        payroll.runPayroll(ps, 1);

        // Money still arrived, just unsplit, straight to the address.
        assertEq(usdc.balanceOf(broken), USDC_500, "fallback delivered");
        assertEq(usdc.balanceOf(address(payroll)), 0, "no residue");
        assertEq(usdc.allowance(address(payroll), address(split)), 0, "allowance cleared");
    }

    // ── 3. Fallback on InvalidBPSTotal ──────────────────────────────────────

    function test_runPayroll_when_payeeHasBadBps_should_fallbackToPlainTransfer() public {
        address broken = _makeBadBpsUser(1); // one 5000-bps bucket, sum != 10000

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = _p(broken, USDC_500, true, bytes32(0));

        vm.prank(employer);
        payroll.runPayroll(ps, 1);

        assertEq(usdc.balanceOf(broken), USDC_500, "fallback delivered");
        // The bad-bps user's hold bucket must NOT have accrued (the split reverted).
        assertEq(_holdBalanceById(broken, 0), 0, "no partial split");
        assertEq(usdc.balanceOf(address(payroll)), 0, "no residue");
    }

    // ── 4. One bad payee does not sink the run ──────────────────────────────

    function test_runPayroll_when_oneBadPayeeAmongGood_should_completeAll() public {
        (address good, address goodAuto) = _makeSplitUser(1);
        address broken = _makeNoBucketUser(2);
        address plain  = _plainPayee(3);

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](3);
        ps[0] = _p(good,   USDC_700, true,  bytes32(0));
        ps[1] = _p(broken, USDC_500, true,  bytes32(0)); // will fall back
        ps[2] = _p(plain,  USDC_400, false, bytes32(0));

        vm.prank(employer);
        payroll.runPayroll(ps, 7);

        assertEq(usdc.balanceOf(goodAuto), (uint256(USDC_700) * 4000) / 10000, "good auto-send");
        assertEq(usdc.balanceOf(broken), USDC_500, "broken fell back");
        assertEq(usdc.balanceOf(plain),  USDC_400, "plain paid");
        assertEq(usdc.balanceOf(address(payroll)), 0, "no residue");
    }

    // ── 5. Emits PayrollRun with correct totals ─────────────────────────────

    function test_runPayroll_should_emitPayrollRunWithTotals() public {
        (address s1,) = _makeSplitUser(1);
        address plain = _plainPayee(1);

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](2);
        ps[0] = _p(s1,    USDC_700, true,  bytes32(0));
        ps[1] = _p(plain, USDC_400, false, bytes32(0));

        vm.expectEmit(true, false, false, true, address(payroll));
        emit PayrollRun(employer, 99, uint256(USDC_700) + USDC_400, 2);

        vm.prank(employer);
        payroll.runPayroll(ps, 99);
    }

    // ── 6. Per-payee outcome codes are correct ──────────────────────────────

    function test_runPayroll_should_emitCorrectOutcomeCodes() public {
        (address good,) = _makeSplitUser(1);
        address broken  = _makeNoBucketUser(2);
        address plain   = _plainPayee(3);

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](3);
        ps[0] = _p(good,   USDC_100, true,  bytes32(uint256(1)));
        ps[1] = _p(broken, USDC_100, true,  bytes32(uint256(2)));
        ps[2] = _p(plain,  USDC_100, false, bytes32(uint256(3)));

        vm.expectEmit(true, true, false, true, address(payroll));
        emit PayrollPayment(employer, good, USDC_100, SPLIT_OK, bytes32(uint256(1)));
        vm.expectEmit(true, true, false, true, address(payroll));
        emit PayrollPayment(employer, broken, USDC_100, FALLBACK, bytes32(uint256(2)));
        vm.expectEmit(true, true, false, true, address(payroll));
        emit PayrollPayment(employer, plain, USDC_100, PLAIN, bytes32(uint256(3)));

        vm.prank(employer);
        payroll.runPayroll(ps, 5);
    }

    // ── 7. Residue backstop returns stuck funds to the caller ───────────────

    function test_runPayroll_when_contractHasStuckFunds_should_sweepToEmployer() public {
        // Someone mistakenly sends USDC directly to the payroll contract.
        usdc.mint(address(payroll), USDC_100);

        address plain = _plainPayee(1);
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = _p(plain, USDC_400, false, bytes32(0));

        uint256 empBefore = usdc.balanceOf(employer);
        vm.prank(employer);
        payroll.runPayroll(ps, 1);

        // Employer pulled 400 out, got the stuck 100 back as residue => net -300.
        assertEq(empBefore - usdc.balanceOf(employer), uint256(USDC_400) - USDC_100, "net after sweep");
        assertEq(usdc.balanceOf(plain), USDC_400, "payee paid");
        assertEq(usdc.balanceOf(address(payroll)), 0, "contract emptied");
    }

    // ── 8. Accounting invariant: contract never retains funds ───────────────

    function test_runPayroll_when_allSplitUsers_should_holdZeroAfter() public {
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](3);
        for (uint160 i = 0; i < 3; i++) {
            (address u,) = _makeSplitUser(i + 1);
            ps[i] = _p(u, USDC_100, true, bytes32(0));
        }
        vm.prank(employer);
        payroll.runPayroll(ps, 1);
        assertEq(usdc.balanceOf(address(payroll)), 0, "no residue");
        assertEq(usdc.allowance(address(payroll), address(split)), 0, "allowance cleared");
    }

    // ── 9. Reverts ──────────────────────────────────────────────────────────

    function test_runPayroll_when_empty_should_revert() public {
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](0);
        vm.prank(employer);
        vm.expectRevert(SplitPayroll.EmptyRun.selector);
        payroll.runPayroll(ps, 1);
    }

    function test_runPayroll_when_tooManyPayees_should_revert() public {
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](101);
        for (uint160 i = 0; i < 101; i++) {
            ps[i] = _p(_plainPayee(i + 1), USDC_100, false, bytes32(0));
        }
        vm.prank(employer);
        vm.expectRevert(SplitPayroll.TooManyPayees.selector);
        payroll.runPayroll(ps, 1);
    }

    function test_runPayroll_when_zeroAmount_should_revert() public {
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = _p(_plainPayee(1), 0, false, bytes32(0));
        vm.prank(employer);
        vm.expectRevert(SplitPayroll.ZeroAmount.selector);
        payroll.runPayroll(ps, 1);
    }

    function test_runPayroll_when_zeroDestination_should_revert() public {
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = _p(address(0), USDC_100, false, bytes32(0));
        vm.prank(employer);
        vm.expectRevert(SplitPayroll.ZeroDestination.selector);
        payroll.runPayroll(ps, 1);
    }

    function test_runPayroll_when_employerHasNotApproved_should_revert() public {
        address poor = makeAddr("poor");
        usdc.mint(poor, USDC_1000);
        // no approve
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = _p(_plainPayee(1), USDC_100, false, bytes32(0));
        vm.prank(poor);
        vm.expectRevert(); // ERC20 insufficient allowance
        payroll.runPayroll(ps, 1);
    }

    // ── 10. Boundary: exactly MAX_PAYEES is allowed ─────────────────────────

    function test_runPayroll_when_exactlyMaxPayees_should_succeed() public {
        uint256 max = payroll.MAX_PAYEES();
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](max);
        for (uint160 i = 0; i < max; i++) {
            ps[i] = _p(_plainPayee(i + 1), USDC_100, false, bytes32(0));
        }
        vm.prank(employer);
        payroll.runPayroll(ps, 1);
        assertEq(usdc.balanceOf(_plainPayee(1)), USDC_100, "first paid");
        assertEq(usdc.balanceOf(_plainPayee(uint160(max))), USDC_100, "last paid");
        assertEq(usdc.balanceOf(address(payroll)), 0, "no residue");
    }

    // ── 11. Reentrancy is blocked ───────────────────────────────────────────

    function test_runPayroll_when_tokenReentersRun_should_revert() public {
        ReentrantUSDC evil = new ReentrantUSDC();
        Split         evilSplit = new Split(address(evil), scheduler);
        SplitPayroll  evilPayroll = new SplitPayroll(address(evil), address(evilSplit));

        evil.mint(employer, USDC_1000);
        vm.prank(employer);
        evil.approve(address(evilPayroll), type(uint256).max);

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = _p(_plainPayee(1), USDC_100, false, bytes32(0));

        // Arm the token to re-enter runPayroll on its first token movement.
        evil.setAttack(
            address(evilPayroll),
            abi.encodeCall(SplitPayroll.runPayroll, (ps, 2))
        );

        vm.prank(employer);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evilPayroll.runPayroll(ps, 1);
    }

    // ── 12. Constructor guards ──────────────────────────────────────────────

    function test_constructor_when_zeroAddress_should_revert() public {
        vm.expectRevert(bytes("zero"));
        new SplitPayroll(address(0), address(split));
        vm.expectRevert(bytes("zero"));
        new SplitPayroll(address(usdc), address(0));
    }

    // ── 13. Local gas snapshot (mock USDC; real-facade numbers come from the
    //        fork benchmark in SplitPayrollFork.t.sol) ────────────────────────

    function test_gas_runPayroll_splitUsers() public {
        _benchSplit(10);
        _benchSplit(25);
        _benchSplit(50);
        _benchSplit(100);
    }

    function _benchSplit(uint256 count) internal {
        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](count);
        for (uint160 i = 0; i < count; i++) {
            (address u,) = _makeSplitUser(uint160(count) * 1000 + i + 1);
            ps[i] = _p(u, USDC_100, true, bytes32(0));
        }
        vm.prank(employer);
        uint256 g0 = gasleft();
        payroll.runPayroll(ps, count);
        uint256 used = g0 - gasleft();
        emit log_named_uint(string.concat("gas mock split-users x", vm.toString(count)), used);
    }

    // ── shared bucket-balance readers ───────────────────────────────────────

    function _holdBalance(address who) internal view returns (uint128) {
        // first (id 0) bucket is the 6000-bps hold bucket for _makeSplitUser
        return _holdBalanceById(who, 0);
    }

    function _holdBalanceById(address who, uint256 id) internal view returns (uint128) {
        Split.Bucket[] memory bs = split.getBuckets(who);
        for (uint256 i; i < bs.length; i++) {
            if (bs[i].id == id) return bs[i].balance;
        }
        return 0;
    }
}
