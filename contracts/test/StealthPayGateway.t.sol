// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC5564Announcer } from "../src/vendor/ERC5564Announcer.sol";
import { StealthPayGateway } from "../src/StealthPayGateway.sol";

// ── Minimal EIP-3009 USDC mock (mirrors Circle FiatTokenV2 receiveWithAuthorization) ──

contract MockUSDC3009 is ERC20 {
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor() ERC20("USD Coin", "USDC") {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("USD Coin")),
            keccak256(bytes("2")),
            block.chainid,
            address(this)
        ));
    }

    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function receiveWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        require(ecrecover(digest, v, r, s) == from, "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

// Announcer that re-enters the gateway during announce(), to probe the guard.
contract ReentrantAnnouncer {
    StealthPayGateway public gateway;
    bool private armed;

    function arm(StealthPayGateway g) external { gateway = g; armed = true; }

    function announce(uint256, address, bytes memory, bytes memory) external {
        if (!armed) return;
        armed = false;
        StealthPayGateway.Authorization memory a = StealthPayGateway.Authorization({
            from: address(1), value: 1, validAfter: 0, validBefore: type(uint256).max,
            nonce: bytes32(0), v: 27, r: bytes32(0), s: bytes32(0)
        });
        StealthPayGateway.StealthAnnouncement memory n = StealthPayGateway.StealthAnnouncement({
            stealthAddress: address(2), ephemeralPubKey: hex"01", metadata: hex"01"
        });
        gateway.payStealth(a, n);
    }
}

contract StealthPayGatewayTest is Test {
    MockUSDC3009      internal usdc;
    ERC5564Announcer  internal announcer;
    StealthPayGateway internal gateway;

    uint256 internal payerPk = 0xA11CE;
    address internal payer;
    address internal stealth = makeAddr("stealth");

    uint256 constant USDC_100 = 100_000_000;

    event Announcement(
        uint256 indexed schemeId, address indexed stealthAddress, address indexed caller,
        bytes ephemeralPubKey, bytes metadata
    );

    function setUp() public {
        usdc      = new MockUSDC3009();
        announcer = new ERC5564Announcer();
        gateway   = new StealthPayGateway(address(usdc), address(announcer));
        payer     = vm.addr(payerPk);
        usdc.mint(payer, 1_000_000_000);
    }

    // Build a payer-signed Authorization for `to` (defaults to the gateway).
    function _auth(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal view returns (StealthPayGateway.Authorization memory a)
    {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, to, value, validAfter, validBefore, nonce))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        a = StealthPayGateway.Authorization({
            from: payer, value: value, validAfter: validAfter, validBefore: validBefore, nonce: nonce, v: v, r: r, s: s
        });
    }

    function _ann(address stealthAddress, bytes memory ephem, bytes memory metadata)
        internal pure returns (StealthPayGateway.StealthAnnouncement memory)
    {
        return StealthPayGateway.StealthAnnouncement({ stealthAddress: stealthAddress, ephemeralPubKey: ephem, metadata: metadata });
    }

    // ── 1. Happy path: pull + forward + announce atomically ─────────────────

    function test_payStealth_happyPath() public {
        StealthPayGateway.Authorization memory a = _auth(address(gateway), USDC_100, 0, type(uint256).max, keccak256("n1"));

        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, stealth, address(gateway), hex"aabb", hex"01deadbeef");

        gateway.payStealth(a, _ann(stealth, hex"aabb", hex"01deadbeef"));

        assertEq(usdc.balanceOf(stealth), USDC_100, "stealth received");
        assertEq(usdc.balanceOf(address(gateway)), 0, "gateway holds nothing");
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - USDC_100, "payer debited");
    }

    // ── 2. Replay: a nonce can be used only once ────────────────────────────

    function test_payStealth_replayRejected() public {
        StealthPayGateway.Authorization memory a = _auth(address(gateway), USDC_100, 0, type(uint256).max, keccak256("n2"));
        gateway.payStealth(a, _ann(stealth, hex"aa", hex"01"));
        vm.expectRevert(bytes("FiatTokenV2: authorization is used"));
        gateway.payStealth(a, _ann(stealth, hex"aa", hex"01"));
    }

    // ── 3. Only the named payee (the gateway) can execute the authorization ─

    function test_receiveWithAuthorization_onlyPayeeCanCall() public {
        StealthPayGateway.Authorization memory a = _auth(address(gateway), USDC_100, 0, type(uint256).max, keccak256("n3"));
        vm.prank(makeAddr("frontrunner"));
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(payer, address(gateway), USDC_100, 0, type(uint256).max, keccak256("n3"), a.v, a.r, a.s);
    }

    // ── 4. A signature over a different `to` cannot be redirected ────────────

    function test_payStealth_wrongPayeeSignatureRejected() public {
        // Signed for a different `to`; the gateway forces to = address(this), so
        // the recovered signer won't match and USDC rejects it.
        StealthPayGateway.Authorization memory a = _auth(makeAddr("elsewhere"), USDC_100, 0, type(uint256).max, keccak256("n4"));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        gateway.payStealth(a, _ann(stealth, hex"aa", hex"01"));
    }

    // ── 5. Validity window ──────────────────────────────────────────────────

    function test_payStealth_expiredRejected() public {
        vm.warp(1_000_000);
        StealthPayGateway.Authorization memory a = _auth(address(gateway), USDC_100, 0, block.timestamp - 1, keccak256("n5"));
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        gateway.payStealth(a, _ann(stealth, hex"aa", hex"01"));
    }

    function test_payStealth_notYetValidRejected() public {
        vm.warp(1_000_000);
        StealthPayGateway.Authorization memory a = _auth(address(gateway), USDC_100, block.timestamp + 100, type(uint256).max, keccak256("n6"));
        vm.expectRevert(bytes("FiatTokenV2: authorization is not yet valid"));
        gateway.payStealth(a, _ann(stealth, hex"aa", hex"01"));
    }

    // ── 6. Input guards ─────────────────────────────────────────────────────

    function test_payStealth_zeroValueRejected() public {
        StealthPayGateway.Authorization memory a = _auth(address(gateway), 0, 0, type(uint256).max, keccak256("n7"));
        vm.expectRevert(StealthPayGateway.ZeroValue.selector);
        gateway.payStealth(a, _ann(stealth, hex"aa", hex"01"));
    }

    function test_payStealth_zeroStealthAddressRejected() public {
        StealthPayGateway.Authorization memory a = _auth(address(gateway), USDC_100, 0, type(uint256).max, keccak256("n8"));
        vm.expectRevert(StealthPayGateway.ZeroStealthAddress.selector);
        gateway.payStealth(a, _ann(address(0), hex"aa", hex"01"));
    }

    // ── 7. Reentrancy is blocked ────────────────────────────────────────────

    function test_payStealth_reentrancyBlocked() public {
        ReentrantAnnouncer evilAnnouncer = new ReentrantAnnouncer();
        StealthPayGateway  evilGateway   = new StealthPayGateway(address(usdc), address(evilAnnouncer));
        evilAnnouncer.arm(evilGateway);

        StealthPayGateway.Authorization memory a = _auth(address(evilGateway), USDC_100, 0, type(uint256).max, keccak256("n9"));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evilGateway.payStealth(a, _ann(stealth, hex"aa", hex"01"));
    }

    // ── 8. Constructor guard ────────────────────────────────────────────────

    function test_constructor_zeroReverts() public {
        vm.expectRevert(bytes("zero"));
        new StealthPayGateway(address(0), address(announcer));
        vm.expectRevert(bytes("zero"));
        new StealthPayGateway(address(usdc), address(0));
    }
}
