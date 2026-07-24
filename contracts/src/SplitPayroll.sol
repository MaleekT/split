// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Minimal external view of Split needed for batch disbursement. Split.sol is
// never imported or modified; this interface is the only coupling point, and it
// mirrors the deployed contract's depositFor signature exactly.
interface ISplit {
    function depositFor(address recipient, uint128 amount) external;
}

/// @title  SplitPayroll: one-transaction batch disbursement for Split
/// @notice An employer approves this contract for a run total and calls
///         `runPayroll` once. Funds are pulled a single time, then routed
///         per payee: Split users receive a bucket-splitting `depositFor`
///         (with a plain-transfer fallback if their bucket config is broken,
///         so one bad payee can never revert the whole run), and non-users
///         receive a plain USDC transfer. The contract is stateless and holds
///         no funds between transactions; any balance it ends a call with is
///         returned to the caller.
/// @dev    No owner, no upgradeability, no persistent storage beyond the
///         inherited ReentrancyGuard flag. Idempotency of `runId` is enforced
///         off-chain by the run-record model, not here (see design doc §7.6);
///         the contract only echoes `runId` in its events for reconciliation.
contract SplitPayroll is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    ISplit public immutable SPLIT;

    /// @notice Hard upper bound on payees per call. Validated in Phase 1 against
    ///         Arc's 30M block gas limit: the mock structural benchmark is ~55k
    ///         gas/payee, and live on-chain anchors (a real facade transfer and a
    ///         real multi-bucket depositFor+split) bound the true cost at roughly
    ///         90-130k gas/payee, so a 100-payee run lands near 40-45% of the
    ///         block limit with comfortable margin. A local forge fork cannot
    ///         exercise the real facade (its transfer path calls an Arc system
    ///         precompile absent from forge's EVM), so the definitive end-to-end
    ///         confirmation is one real testnet runPayroll after deployment.
    uint256 public constant MAX_PAYEES = 100;

    // Per-payee outcome codes, emitted in PayrollPayment.
    uint8 internal constant OUTCOME_SPLIT    = 0; // depositFor succeeded; routed through buckets
    uint8 internal constant OUTCOME_FALLBACK = 1; // depositFor reverted; plain-transferred instead
    uint8 internal constant OUTCOME_PLAIN    = 2; // non-Split payee; plain transfer

    struct Payee {
        address dest;        // resolved destination address (never a handle)
        uint128 amount;      // 6-decimal USDC units
        bool    isSplitUser; // route through Split.depositFor if true
        bytes32 memoHash;    // opaque per-payee reference, echoed in the event
    }

    event PayrollRun(address indexed employer, uint256 runId, uint256 total, uint256 payeeCount);
    event PayrollPayment(address indexed employer, address indexed payee, uint128 amount, uint8 outcome, bytes32 memoHash);

    error EmptyRun();
    error TooManyPayees();
    error ZeroAmount();
    error ZeroDestination();

    constructor(address usdc, address split_) {
        require(usdc != address(0) && split_ != address(0), "zero");
        USDC  = IERC20(usdc);
        SPLIT = ISplit(split_);
    }

    /// @notice Execute one batched payroll run.
    /// @param payees The disbursement list. Destinations must be pre-resolved
    ///        (this contract never resolves handles) and non-zero.
    /// @param runId  Caller-chosen correlation/idempotency key. Not enforced
    ///        on-chain; echoed in PayrollRun for off-chain reconciliation.
    function runPayroll(Payee[] calldata payees, uint256 runId) external nonReentrant {
        uint256 n = payees.length;
        if (n == 0)          revert EmptyRun();
        if (n > MAX_PAYEES)  revert TooManyPayees();

        // ── Pass 1: validate and total (no external calls) ──────────────────
        uint256 total;
        uint256 splitTotal;
        for (uint256 i = 0; i < n; ) {
            Payee calldata p = payees[i];
            if (p.amount == 0)          revert ZeroAmount();
            if (p.dest == address(0))   revert ZeroDestination();
            total += p.amount;
            if (p.isSplitUser) splitTotal += p.amount;
            unchecked { i++; }
        }

        // Pull the whole run once from the employer.
        USDC.safeTransferFrom(msg.sender, address(this), total);

        // Approve Split for exactly the split subtotal (forceApprove handles
        // any non-zero existing allowance defensively).
        if (splitTotal > 0) USDC.forceApprove(address(SPLIT), splitTotal);

        emit PayrollRun(msg.sender, runId, total, n);

        // ── Pass 2: disburse ────────────────────────────────────────────────
        for (uint256 i = 0; i < n; ) {
            Payee calldata p = payees[i];
            uint8 outcome;
            if (p.isSplitUser) {
                // try/catch is the core failure isolation: a payee with no
                // buckets or a bad bps total reverts _split, we catch it, and
                // fall back to a plain transfer so the run always completes.
                try SPLIT.depositFor(p.dest, p.amount) {
                    outcome = OUTCOME_SPLIT;
                } catch {
                    USDC.safeTransfer(p.dest, p.amount);
                    outcome = OUTCOME_FALLBACK;
                }
            } else {
                USDC.safeTransfer(p.dest, p.amount);
                outcome = OUTCOME_PLAIN;
            }
            emit PayrollPayment(msg.sender, p.dest, p.amount, outcome, p.memoHash);
            unchecked { i++; }
        }

        // Never leave a standing allowance to Split (fallback paths leave the
        // pre-approved-but-unused portion; zero it out unconditionally).
        if (splitTotal > 0) USDC.forceApprove(address(SPLIT), 0);

        // Return any residual balance to the caller so the contract never
        // retains funds between transactions. In correct operation this nets
        // to exactly zero (every payee removes exactly its amount); the sweep
        // is a defensive backstop that also recovers any USDC mistakenly sent
        // directly to this contract, handing it to the current run's employer.
        uint256 residue = USDC.balanceOf(address(this));
        if (residue > 0) USDC.safeTransfer(msg.sender, residue);
    }
}
