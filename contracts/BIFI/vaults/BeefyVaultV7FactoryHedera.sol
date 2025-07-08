// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "./BeefyVaultV7Hedera.sol";
import "./BeefyVaultConcLiqHedera.sol";
import "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";

// Beefy Finance Vault V7 Proxy Factory for Hedera
// Minimal proxy pattern for creating new Beefy vaults
contract BeefyVaultV7FactoryHedera {
    using ClonesUpgradeable for address;

    // Contract template for deploying proxied Beefy vaults
    BeefyVaultV7Hedera public instance;
    BeefyVaultConcLiqHedera public instanceConcLiq;

    event ProxyCreated(address proxy);

    // Initializes the Factory with an instance of the Beefy Vault V7
    constructor(address _instance, address payable _instanceConcLiq) {
        if (_instance == address(0)) {
            instance = new BeefyVaultV7Hedera();
        } else {
            instance = BeefyVaultV7Hedera(_instance);
        }
        if (_instanceConcLiq == address(0)) {
            instanceConcLiq = new BeefyVaultConcLiqHedera();
        } else {
            instanceConcLiq = BeefyVaultConcLiqHedera(payable(_instanceConcLiq));
        }
    }

    // Creates a new Beefy Vault V7 as a proxy of the template instance
    // A reference to the new proxied Beefy Vault V7
    function cloneVault() external returns (BeefyVaultV7Hedera) {
        return BeefyVaultV7Hedera(cloneContract(address(instance)));
    }

    function cloneVaultCLM() external returns (BeefyVaultConcLiqHedera) {
        return BeefyVaultConcLiqHedera(payable(cloneContract(address(instanceConcLiq))));
    }

    // Deploys and returns the address of a clone that mimics the behaviour of `implementation`
    function cloneContract(address implementation) public returns (address) {
        address proxy = implementation.clone();
        emit ProxyCreated(proxy);
        return proxy;
    }
}
