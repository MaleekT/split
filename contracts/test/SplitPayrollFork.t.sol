// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Split } from "../src/Split.sol";
import { SplitPayroll } from "../src/SplitPayroll.sol";

interface IUSDCFacade {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

// Real-facade gas benchmark for SplitPayroll, run against a fork of Arc Testnet
// so gas reflects the actual USDC facade at 0x3600... and the live Split
// contract's real storage semantics (cold SLOADs, real transfer costs) rather
// than a warm-storage mock.
//
// Skipped automatically when ARC_RPC_URL is unset, so the default `forge test`
// stays green offline. Run it with, e.g.:
//   ARC_RPC_URL=https://rpc.testnet.arc.network forge test --match-path test/SplitPayrollFork.t.sol -vv
contract SplitPayrollForkTest is Test {
    // Arc Testnet, verified live in Phase 0.
    address constant USDC  = 0x3600000000000000000000000000000000000000;
    address constant SPLIT = 0x071c2E7B525Db9850C9500326CF5D0a415fe6501;

    SplitPayroll internal payroll;
    address internal employer = makeAddr("fork-employer");
    bool    internal forked;

    uint128 constant USDC_100 = 100_000_000; // 100 USDC (6 decimals)

    function setUp() public {
        string memory rpc = vm.envOr("ARC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        uint256 forkBlock = vm.envOr("ARC_FORK_BLOCK", uint256(53_026_548));
        vm.createSelectFork(rpc, forkBlock);
        forked = true;

        payroll = new SplitPayroll(USDC, SPLIT);

        // On Arc, the ERC-20 USDC pot and the native gas balance are the same
        // pot (Phase 0 finding 2). Fund the employer via native balance and
        // verify the facade reflects it before relying on it.
        vm.deal(employer, 5_000_000 ether);
    }

    function _skipUnlessForked() internal {
        if (!forked) vm.skip(true);
    }

    // Sanity: confirm the duality holds under fork before benchmarking on it.
    function test_fork_dualityHolds() public {
        _skipUnlessForked();
        uint256 bal = IUSDCFacade(USDC).balanceOf(employer);
        emit log_named_uint("employer USDC balanceOf after vm.deal(5,000,000 ether)", bal);
        assertGt(bal, 0, "facade did not reflect native deal; benchmark needs a different funding path");
    }

    // A local forge fork CANNOT exercise the real USDC facade's transfer path:
    // its transferFrom delegatecalls an implementation that staticcalls an Arc
    // system precompile at 0x1800...0001 (selector 0x8e204c43), which forge's
    // local EVM does not implement, so any USDC movement reverts under fork.
    // The real-facade gas benchmark is therefore measured from live Arc
    // on-chain receipts (see FEASIBILITY doc, Phase 1 findings) and confirmed
    // definitively by one real testnet runPayroll after deployment, not here.
    // This test documents the limitation so the gap is explicit, not silent.
    function test_fork_realFacadeTransferUnavailableUnderFork() public {
        _skipUnlessForked();

        vm.prank(employer);
        IUSDCFacade(USDC).approve(address(payroll), type(uint256).max);

        SplitPayroll.Payee[] memory ps = new SplitPayroll.Payee[](1);
        ps[0] = SplitPayroll.Payee({ dest: makeAddr("payee"), amount: USDC_100, isSplitUser: false, memoHash: bytes32(0) });

        // The facade's transferFrom reverts under fork (missing Arc precompile).
        vm.prank(employer);
        vm.expectRevert();
        payroll.runPayroll(ps, 1);
    }
}
