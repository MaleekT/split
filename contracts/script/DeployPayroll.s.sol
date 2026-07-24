// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { SplitPayroll } from "../src/SplitPayroll.sol";

// Deploys SplitPayroll against an already-deployed Split contract and the
// USDC address. Mirrors Deploy.s.sol: reads addresses from the environment and
// relies on the caller supplying the broadcasting key via forge's --account /
// --private-key flag (no key is ever read or stored by this script).
//
//   USDC_ADDRESS   the ERC-20 USDC facade (Arc Testnet: 0x3600...0000)
//   SPLIT_ADDRESS  the live Split contract SplitPayroll routes into
contract DeployPayroll is Script {
    function run() external {
        address usdc  = vm.envAddress("USDC_ADDRESS");
        address split = vm.envAddress("SPLIT_ADDRESS");

        require(usdc  != address(0), "USDC_ADDRESS is zero");
        require(split != address(0), "SPLIT_ADDRESS is zero");

        vm.startBroadcast();
        SplitPayroll payroll = new SplitPayroll(usdc, split);
        vm.stopBroadcast();

        console.log("SplitPayroll deployed at:", address(payroll));
        console.log("USDC:                    ", usdc);
        console.log("Split:                   ", split);
    }
}
