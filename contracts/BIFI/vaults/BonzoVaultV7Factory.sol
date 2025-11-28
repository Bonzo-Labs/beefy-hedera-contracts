// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import "./BonzoVaultV7.sol";
import "./BonzoVaultConcLiq.sol";
import "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";

// Bonzo Finance Vault V7 Proxy Factory
// Minimal proxy pattern for creating new Bonzo vaults
contract BonzoVaultV7Factory {
    using ClonesUpgradeable for address;

    // Contract template for deploying proxied Bonzo vaults
    BonzoVaultV7 public instance;
    BonzoVaultConcLiq public instanceConcLiq;

    event ProxyCreated(address proxy);

    // Initializes the Factory with an instance of the Bonzo Vault V7
    constructor(address _instance, address payable _instanceConcLiq) {
        if (_instance == address(0)) {
            instance = new BonzoVaultV7();
        } else {
            instance = BonzoVaultV7(_instance);
        }
        if (_instanceConcLiq == address(0)) {
            instanceConcLiq = new BonzoVaultConcLiq();
        } else {
            instanceConcLiq = BonzoVaultConcLiq(payable(_instanceConcLiq));
        }
    }

    // Creates a new Bonzo Vault V7 as a proxy of the template instance
    // A reference to the new proxied Bonzo Vault V7
    function cloneVault() external returns (BonzoVaultV7) {
        return BonzoVaultV7(cloneContract(address(instance)));
    }

    function cloneVaultCLM() external returns (BonzoVaultConcLiq) {
        return BonzoVaultConcLiq(payable(cloneContract(address(instanceConcLiq))));
    }

    // Deploys and returns the address of a clone that mimics the behaviour of `implementation`
    function cloneContract(address implementation) public returns (address) {
        address proxy = implementation.clone();
        emit ProxyCreated(proxy);
        return proxy;
    }
}
