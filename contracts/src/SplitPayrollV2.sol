// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC5564Announcer } from "./vendor/ERC5564Announcer.sol";

interface ISplit {
    function depositFor(address recipient, uint128 amount) external;
}

/// @title  SplitPayrollV2 — batch disbursement with a private-payment mode
/// @notice A superset of SplitPayroll: the same one-transaction batch that routes
///         Split users through their buckets and pays others directly, PLUS a
///         per-payee "private" mode that forwards to a one-time stealth address
///         (computed by the employer's client from the payee's meta-address) and
///         emits the ERC-5564 announcement, so an opted-in contractor receives
///         unlinkably inside the same batch action.
/// @dev    Stateless, no owner, holds funds only within the call. "Private
///         payroll" hides the payee from OUTSIDE observers only — the employer
///         still knows who is on the roster and what each is paid.
contract SplitPayrollV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20           public immutable USDC;
    ISplit           public immutable SPLIT;
    ERC5564Announcer public immutable ANNOUNCER;

    uint256 public constant MAX_PAYEES = 100;
    uint256 public constant SCHEME_ID  = 1; // ERC-5564 secp256k1

    // Payee.mode
    uint8 internal constant MODE_SPLIT   = 0; // route through the payee's buckets
    uint8 internal constant MODE_PLAIN   = 1; // direct transfer
    uint8 internal constant MODE_PRIVATE = 2; // transfer to stealth address + announce

    // PayrollPayment.outcome
    uint8 internal constant OUTCOME_SPLIT    = 0;
    uint8 internal constant OUTCOME_FALLBACK = 1;
    uint8 internal constant OUTCOME_PLAIN    = 2;
    uint8 internal constant OUTCOME_PRIVATE  = 3;

    struct Payee {
        address dest;            // recipient (split/plain) or stealth address (private)
        uint128 amount;          // 6-decimal USDC
        uint8   mode;            // 0 split, 1 plain, 2 private
        bytes32 memoHash;        // opaque reference, echoed in the event
        bytes   ephemeralPubKey; // private mode only (else empty)
        bytes   metadata;        // private mode only; byte 0 is the view tag (else empty)
    }

    event PayrollRun(address indexed employer, uint256 runId, uint256 total, uint256 payeeCount);
    event PayrollPayment(address indexed employer, address indexed payee, uint128 amount, uint8 outcome, bytes32 memoHash);

    error EmptyRun();
    error TooManyPayees();
    error ZeroAmount();
    error ZeroDestination();
    error BadMode();

    constructor(address usdc, address split_, address announcer) {
        require(usdc != address(0) && split_ != address(0) && announcer != address(0), "zero");
        USDC      = IERC20(usdc);
        SPLIT     = ISplit(split_);
        ANNOUNCER = ERC5564Announcer(announcer);
    }

    function runPayroll(Payee[] calldata payees, uint256 runId) external nonReentrant {
        uint256 n = payees.length;
        if (n == 0)         revert EmptyRun();
        if (n > MAX_PAYEES) revert TooManyPayees();

        uint256 total;
        uint256 splitTotal;
        for (uint256 i = 0; i < n; ) {
            Payee calldata p = payees[i];
            if (p.amount == 0)        revert ZeroAmount();
            if (p.dest == address(0)) revert ZeroDestination();
            if (p.mode > MODE_PRIVATE) revert BadMode();
            total += p.amount;
            if (p.mode == MODE_SPLIT) splitTotal += p.amount;
            unchecked { i++; }
        }

        USDC.safeTransferFrom(msg.sender, address(this), total);
        if (splitTotal > 0) USDC.forceApprove(address(SPLIT), splitTotal);

        emit PayrollRun(msg.sender, runId, total, n);

        for (uint256 i = 0; i < n; ) {
            Payee calldata p = payees[i];
            uint8 outcome;
            if (p.mode == MODE_SPLIT) {
                try SPLIT.depositFor(p.dest, p.amount) {
                    outcome = OUTCOME_SPLIT;
                } catch {
                    USDC.safeTransfer(p.dest, p.amount);
                    outcome = OUTCOME_FALLBACK;
                }
            } else if (p.mode == MODE_PRIVATE) {
                // Forward to the one-time stealth address and announce, atomically.
                USDC.safeTransfer(p.dest, p.amount);
                ANNOUNCER.announce(SCHEME_ID, p.dest, p.ephemeralPubKey, p.metadata);
                outcome = OUTCOME_PRIVATE;
            } else {
                USDC.safeTransfer(p.dest, p.amount);
                outcome = OUTCOME_PLAIN;
            }
            emit PayrollPayment(msg.sender, p.dest, p.amount, outcome, p.memoHash);
            unchecked { i++; }
        }

        if (splitTotal > 0) USDC.forceApprove(address(SPLIT), 0);
        uint256 residue = USDC.balanceOf(address(this));
        if (residue > 0) USDC.safeTransfer(msg.sender, residue);
    }
}
