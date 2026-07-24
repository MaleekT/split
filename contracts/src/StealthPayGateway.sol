// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC5564Announcer } from "./vendor/ERC5564Announcer.sol";

// Minimal EIP-3009 view of USDC. Arc's USDC (FiatTokenV2) implements this,
// verified live in Phase 0. receiveWithAuthorization requires the caller to be
// the authorization's payee `to`, which is what makes this gateway the only
// contract able to execute a given payer signature (closes the front-running gap
// that transferWithAuthorization has).
interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title  StealthPayGateway — atomic private payment periphery for Split
/// @notice The payer-side "decided flow": one EIP-712 `receiveWithAuthorization`
///         signature plus one call here. This contract pulls the authorized USDC
///         from the payer, forwards it to the computed one-time stealth address,
///         and emits the ERC-5564 announcement, all in a single transaction.
///         Transfer and announcement can never be separated, so a private payment
///         can never land without the announcement that lets its recipient find it.
/// @dev    Stateless, no owner, holds funds only within the call. Pull equals
///         forward, so the contract never retains a balance in normal operation.
contract StealthPayGateway is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20           public immutable USDC;
    ERC5564Announcer public immutable ANNOUNCER;

    /// @notice ERC-5564 scheme id for secp256k1 stealth addresses.
    uint256 public constant SCHEME_ID = 1;

    /// @notice The payer's EIP-3009 `ReceiveWithAuthorization`, signed over
    ///         (from, this gateway as `to`, value, validAfter, validBefore, nonce).
    struct Authorization {
        address from;
        uint256 value;       // USDC amount (6 decimals), pulled and forwarded exactly
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice The ERC-5564 announcement details the payer computed.
    struct StealthAnnouncement {
        address stealthAddress; // the one-time recipient address
        bytes   ephemeralPubKey; // ephemeral public key the recipient scans with
        bytes   metadata;        // byte 0 MUST be the view tag
    }

    error ZeroStealthAddress();
    error ZeroValue();

    constructor(address usdc, address announcer) {
        require(usdc != address(0) && announcer != address(0), "zero");
        USDC      = IERC20(usdc);
        ANNOUNCER = ERC5564Announcer(announcer);
    }

    /// @notice Execute one private payment: pull the authorized USDC from the
    ///         payer, forward it to the stealth address, and announce, atomically.
    function payStealth(Authorization calldata auth, StealthAnnouncement calldata ann)
        external
        nonReentrant
    {
        if (ann.stealthAddress == address(0)) revert ZeroStealthAddress();
        if (auth.value == 0)                  revert ZeroValue();

        // 1. Pull the authorized funds into this gateway. Because `to` is this
        //    contract, USDC's `require(caller == payee)` means only this gateway
        //    can execute the payer's signature.
        IEIP3009(address(USDC)).receiveWithAuthorization(
            auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
        );

        // 2. Forward the exact amount to the one-time stealth address.
        USDC.safeTransfer(ann.stealthAddress, auth.value);

        // 3. Announce, atomically with the transfer, so the recipient (and only
        //    the recipient) can detect the payment by scanning announcements.
        ANNOUNCER.announce(SCHEME_ID, ann.stealthAddress, ann.ephemeralPubKey, ann.metadata);
    }
}
