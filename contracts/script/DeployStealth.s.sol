// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { ERC5564Announcer } from "../src/vendor/ERC5564Announcer.sol";
import { ERC6538Registry } from "../src/vendor/ERC6538Registry.sol";
import { StealthPayGateway } from "../src/StealthPayGateway.sol";

// Deploys the stealth-address infrastructure to Arc Testnet (all confirmed
// absent in Phase 0): the ERC-5564 Announcer, the ERC-6538 Registry, and the
// StealthPayGateway wired to the freshly deployed Announcer. Relies on the
// broadcasting key supplied via forge's --account / --private-key flag; no key
// is read or stored by this script.
//
//   USDC_ADDRESS — the ERC-20 USDC facade (Arc Testnet: 0x3600...0000)
contract DeployStealth is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc != address(0), "USDC_ADDRESS is zero");

        vm.startBroadcast();
        ERC5564Announcer announcer = new ERC5564Announcer();
        ERC6538Registry  registry  = new ERC6538Registry();
        StealthPayGateway gateway   = new StealthPayGateway(usdc, address(announcer));
        vm.stopBroadcast();

        console.log("ERC5564Announcer:  ", address(announcer));
        console.log("ERC6538Registry:   ", address(registry));
        console.log("StealthPayGateway: ", address(gateway));
        console.log("USDC:              ", usdc);
    }
}
