// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Split } from "../src/Split.sol";
import { SplitPayrollV2 } from "../src/SplitPayrollV2.sol";
import { ERC5564Announcer } from "../src/vendor/ERC5564Announcer.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// Re-enters runPayroll during a transfer to probe the guard.
contract ReentrantUSDC is ERC20 {
    address public target; bytes public data;
    constructor() ERC20("Evil", "eUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setAttack(address t, bytes calldata d) external { target = t; data = d; }
    function _hook() private {
        address t = target; if (t == address(0)) return;
        target = address(0);
        (bool ok, bytes memory ret) = t.call(data); target = t;
        if (!ok && ret.length > 0) assembly { revert(add(ret, 32), mload(ret)) }
    }
    function transferFrom(address f, address t, uint256 a) public override returns (bool) { bool ok = super.transferFrom(f, t, a); _hook(); return ok; }
    function transfer(address t, uint256 a) public override returns (bool) { bool ok = super.transfer(t, a); _hook(); return ok; }
}

contract SplitPayrollV2Test is Test {
    Split           internal split;
    SplitPayrollV2  internal payroll;
    ERC5564Announcer internal announcer;
    MockUSDC        internal usdc;

    address internal employer  = makeAddr("employer");
    address internal scheduler = makeAddr("scheduler");

    uint128 constant U100 = 100_000_000;
    uint128 constant U700 = 700_000_000;

    event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata);
    event PayrollPayment(address indexed employer, address indexed payee, uint128 amount, uint8 outcome, bytes32 memoHash);

    function setUp() public {
        usdc      = new MockUSDC();
        split     = new Split(address(usdc), scheduler);
        announcer = new ERC5564Announcer();
        payroll   = new SplitPayrollV2(address(usdc), address(split), address(announcer));
        usdc.mint(employer, 1_000_000_000_000);
        vm.prank(employer);
        usdc.approve(address(payroll), type(uint256).max);
    }

    function _splitUser(uint160 seed) internal returns (address u, address autoDest) {
        u = address(uint160(0x100000) + seed); autoDest = address(uint160(0x200000) + seed);
        vm.startPrank(u);
        split.addBucket("save", 6000, address(0));
        split.addBucket("spend", 4000, autoDest);
        vm.stopPrank();
    }

    function _p(address dest, uint128 amount, uint8 mode, bytes memory eph, bytes memory md)
        internal pure returns (SplitPayrollV2.Payee memory)
    {
        return SplitPayrollV2.Payee({ dest: dest, amount: amount, mode: mode, memoHash: bytes32(0), ephemeralPubKey: eph, metadata: md });
    }

    // ── Mixed run: split + plain + private ──────────────────────────────────

    function test_runPayroll_mixed_split_plain_private() public {
        (address su, address autoDest) = _splitUser(1);
        address plain   = address(uint160(0x300001));
        address stealth = address(uint160(0x400001));

        SplitPayrollV2.Payee[] memory ps = new SplitPayrollV2.Payee[](3);
        ps[0] = _p(su,      U700, 0, "", "");
        ps[1] = _p(plain,   U100, 1, "", "");
        ps[2] = _p(stealth, U100, 2, hex"aabbcc", hex"01deadbeef");

        // Private payee announces to the stealth address (not the real contractor).
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, stealth, address(payroll), hex"aabbcc", hex"01deadbeef");

        vm.prank(employer);
        payroll.runPayroll(ps, 1);

        // split user: 60% held, 40% auto-sent
        assertEq(usdc.balanceOf(autoDest), (uint256(U700) * 4000) / 10000, "split auto-send");
        // plain + private both land at their destinations
        assertEq(usdc.balanceOf(plain),   U100, "plain paid");
        assertEq(usdc.balanceOf(stealth), U100, "private landed at stealth address");
        // contract holds nothing, allowance cleared
        assertEq(usdc.balanceOf(address(payroll)), 0, "no residue");
        assertEq(usdc.allowance(address(payroll), address(split)), 0, "allowance cleared");
    }

    // ── Private mode emits the private outcome for the stealth address ──────

    function test_private_emitsPrivateOutcome() public {
        address stealth = address(uint160(0x400002));
        SplitPayrollV2.Payee[] memory ps = new SplitPayrollV2.Payee[](1);
        ps[0] = _p(stealth, U100, 2, hex"aa", hex"01");

        vm.expectEmit(true, true, false, true, address(payroll));
        emit PayrollPayment(employer, stealth, U100, 3, bytes32(0)); // outcome 3 = private

        vm.prank(employer);
        payroll.runPayroll(ps, 1);
    }

    // ── Fallback still isolates a broken split payee ────────────────────────

    function test_split_brokenBucket_fallsBack() public {
        address broken = address(uint160(0x500001)); // no buckets
        SplitPayrollV2.Payee[] memory ps = new SplitPayrollV2.Payee[](1);
        ps[0] = _p(broken, U100, 0, "", "");
        vm.prank(employer);
        payroll.runPayroll(ps, 1);
        assertEq(usdc.balanceOf(broken), U100, "fallback delivered to same payee");
    }

    // ── Reverts ─────────────────────────────────────────────────────────────

    function test_revert_badMode() public {
        SplitPayrollV2.Payee[] memory ps = new SplitPayrollV2.Payee[](1);
        ps[0] = _p(address(uint160(1)), U100, 3, "", ""); // mode 3 invalid
        vm.prank(employer);
        vm.expectRevert(SplitPayrollV2.BadMode.selector);
        payroll.runPayroll(ps, 1);
    }

    function test_revert_zeroDestination() public {
        SplitPayrollV2.Payee[] memory ps = new SplitPayrollV2.Payee[](1);
        ps[0] = _p(address(0), U100, 1, "", "");
        vm.prank(employer);
        vm.expectRevert(SplitPayrollV2.ZeroDestination.selector);
        payroll.runPayroll(ps, 1);
    }

    function test_revert_empty() public {
        SplitPayrollV2.Payee[] memory ps = new SplitPayrollV2.Payee[](0);
        vm.prank(employer);
        vm.expectRevert(SplitPayrollV2.EmptyRun.selector);
        payroll.runPayroll(ps, 1);
    }

    // ── Reentrancy blocked ──────────────────────────────────────────────────

    function test_reentrancyBlocked() public {
        ReentrantUSDC evil = new ReentrantUSDC();
        Split evilSplit = new Split(address(evil), scheduler);
        ERC5564Announcer evilAnn = new ERC5564Announcer();
        SplitPayrollV2 evilPayroll = new SplitPayrollV2(address(evil), address(evilSplit), address(evilAnn));
        evil.mint(employer, 1_000_000_000);
        vm.prank(employer);
        evil.approve(address(evilPayroll), type(uint256).max);

        SplitPayrollV2.Payee[] memory ps = new SplitPayrollV2.Payee[](1);
        ps[0] = _p(address(uint160(0x600001)), U100, 1, "", "");
        evil.setAttack(address(evilPayroll), abi.encodeCall(SplitPayrollV2.runPayroll, (ps, 2)));

        vm.prank(employer);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evilPayroll.runPayroll(ps, 1);
    }

    // ── Constructor guard ───────────────────────────────────────────────────

    function test_constructor_zeroReverts() public {
        vm.expectRevert(bytes("zero"));
        new SplitPayrollV2(address(0), address(split), address(announcer));
        vm.expectRevert(bytes("zero"));
        new SplitPayrollV2(address(usdc), address(0), address(announcer));
        vm.expectRevert(bytes("zero"));
        new SplitPayrollV2(address(usdc), address(split), address(0));
    }
}
