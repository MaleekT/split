// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { SplitPayrollV2 } from "../src/SplitPayrollV2.sol";

// Deploys SplitPayrollV2 (payroll with the private-payment mode). Requires the
// ERC-5564 Announcer to already be deployed (run DeployStealth first). Relies on
// the broadcasting key from forge's --account / --private-key flag.
//
//   USDC_ADDRESS      — ERC-20 USDC facade (Arc Testnet: 0x3600...0000)
//   SPLIT_ADDRESS     — the live Split contract
//   ANNOUNCER_ADDRESS — the ERC-5564 Announcer from DeployStealth
contract DeployPayrollV2 is Script {
    function run() external {
        address usdc      = vm.envAddress("USDC_ADDRESS");
        address split     = vm.envAddress("SPLIT_ADDRESS");
        address announcer = vm.envAddress("ANNOUNCER_ADDRESS");
        require(usdc != address(0) && split != address(0) && announcer != address(0), "zero env");

        vm.startBroadcast();
        SplitPayrollV2 payroll = new SplitPayrollV2(usdc, split, announcer);
        vm.stopBroadcast();

        console.log("SplitPayrollV2:", address(payroll));
        console.log("USDC:          ", usdc);
        console.log("Split:         ", split);
        console.log("Announcer:     ", announcer);
    }
}
