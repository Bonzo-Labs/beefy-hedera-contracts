# Bonzo Strategy Features

This document outlines the features that should be implemented in any new strategy before it is displayed in the Bonzo UI.

## Required Features

### 1. Harvest Function
- Must have a `harvest()` function that can be called by anyone
- Should harvest rewards and reinvest them
- Should emit appropriate events

### 2. Emergency Functions
- Must have a `panic()` function to withdraw all funds in emergency
- Must have an `unpanic()` function to resume normal operations
- Should have proper access controls

### 3. Fee Management
- Should implement a fee structure (call fee, strategist fee, platform fee)
- Should have a `chargeFees()` function
- Should emit fee events

### 4. Access Control
- Should have proper ownership management
- Should have timelock or multisig for critical functions
- Should have guardian role for emergency functions

### 5. Events
- Should emit events for all important state changes
- Should include proper indexed parameters for efficient filtering

### 6. Reentrancy Protection
- Should use ReentrancyGuard or equivalent protection
- Should follow checks-effects-interactions pattern

### 7. Pausability
- Should be pausable in emergency situations
- Should have proper pause/unpause functions

### 8. Upgradeability
- Should be upgradeable if using proxy pattern
- Should have proper upgrade mechanisms

### 9. Oracle Integration
- Should use reliable price oracles
- Should have fallback mechanisms

### 10. Gas Optimization
- Should be gas efficient
- Should use appropriate data structures

## Optional Features

### 1. Harvest on Deposit
- Can implement harvest on deposit for better UX
- Should be configurable

### 2. Multiple Reward Tokens
- Can support multiple reward tokens
- Should handle complex reward structures

### 3. Leverage
- Can implement leverage strategies
- Should have proper risk management

### 4. Cross-Chain
- Can support cross-chain operations
- Should use reliable bridges

## Testing Requirements

### 1. Unit Tests
- Should have comprehensive unit tests
- Should test all major functions

### 2. Integration Tests
- Should test integration with external protocols
- Should test fee calculations

### 3. Fork Tests
- Should test on forked mainnet
- Should test with real token amounts

### 4. Gas Tests
- Should test gas usage
- Should optimize for gas efficiency

## Security Considerations

### 1. Access Control
- Should have proper access controls
- Should use timelock for critical functions

### 2. Reentrancy
- Should protect against reentrancy attacks
- Should follow best practices

### 3. Oracle Manipulation
- Should use reliable oracles
- Should have fallback mechanisms

### 4. Slippage Protection
- Should protect against slippage
- Should have proper slippage controls

## Documentation

### 1. NatSpec
- Should have comprehensive NatSpec documentation
- Should document all functions and events

### 2. README
- Should have a detailed README
- Should include deployment instructions

### 3. Comments
- Should have clear inline comments
- Should explain complex logic

## Deployment Checklist

### 1. Verification
- Should be verified on block explorers
- Should have proper constructor arguments

### 2. Testing
- Should be tested on testnets
- Should be tested with real tokens

### 3. Monitoring
- Should have proper monitoring
- Should have alert mechanisms

### 4. Documentation
- Should have deployment documentation
- Should have user guides

## References

For more detailed information about strategy development, see the design at issue [#37](https://github.com/bonzofinance/bonzo-contracts/issues/37)