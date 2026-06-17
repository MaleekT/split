// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { Split } from "../src/Split.sol";

contract Deploy is Script {
    function run() external {
        address usdc      = vm.envAddress("USDC_ADDRESS");
        address scheduler = vm.envAddress("SCHEDULER_ADDRESS");

        require(usdc      != address(0), "USDC_ADDRESS is zero");
        require(scheduler != address(0), "SCHEDULER_ADDRESS is zero");

        vm.startBroadcast();
        Split split = new Split(usdc, scheduler);
        vm.stopBroadcast();

        console.log("Split deployed at:", address(split));
        console.log("USDC:             ", usdc);
        console.log("Scheduler:        ", scheduler);
    }
}
