// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { BucketLockFactory } from "../src/BucketLockFactory.sol";

/**
 * Deploys BucketLockFactory to Arc Testnet. Matches the DeployStealth /
 * DeployPayroll pattern: the broadcasting key arrives via forge's --private-key
 * or --account flag and is never read or stored by this script.
 *
 *   USDC_ADDRESS     — the ERC-20 USDC facade (Arc Testnet: 0x3600...0000)
 *   TREASURY_ADDRESS — receives the 10% early-withdrawal penalty
 *
 * The treasury is IMMUTABLE on the factory and is inherited by every lock it
 * creates, permanently. Changing it later means deploying a new factory; locks
 * already created keep paying the address they were born with, for their whole
 * life. On testnet a throwaway is fine. Mainnet requires a Safe, and that is a
 * hard gate, not a preference.
 */
contract DeployBucketLock is Script {
    function run() external {
        address usdc     = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        require(usdc != address(0),     "USDC_ADDRESS is zero");
        require(treasury != address(0), "TREASURY_ADDRESS is zero");

        // The factory's `token` is immutable and is inherited by every lock it
        // ever creates, so a typo'd env var would produce a permanently wrong
        // factory that can only be fixed by redeploying. Both checks are free and
        // run before broadcast.
        require(usdc.code.length > 0, "USDC_ADDRESS has no code");
        // Rule 3 of split-CLAUDE.md: USDC is 6 decimals as an ERC-20, and every
        // amount in this feature is raw 6-decimal units. Deploying against an
        // 18-decimal token would silently break the penalty and target maths.
        require(IERC20Metadata(usdc).decimals() == 6, "USDC_ADDRESS is not 6 decimals");

        vm.startBroadcast();
        BucketLockFactory factory = new BucketLockFactory(IERC20(usdc), treasury);
        vm.stopBroadcast();

        // Printed so the values the frontend must pin can be copied verbatim into
        // its trusted-factory allowlist, rather than being retyped from memory.
        console.log("BucketLockFactory: ", address(factory));
        console.log("  VERSION:         ", factory.VERSION());
        console.log("  PENALTY_BPS:     ", factory.PENALTY_BPS());
        console.log("  MIN_DURATION:    ", factory.MIN_DURATION());
        console.log("  token:           ", address(factory.token()));
        console.log("  treasury:        ", factory.treasury());
    }
}
