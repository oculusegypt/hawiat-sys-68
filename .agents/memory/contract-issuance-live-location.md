---
name: Contract issuance and live location
description: Contract pricing, conditional business identifiers, dispatch creation, and container location behavior.
---

For container contracts, manual amount entry is the default; dynamic pricing is an explicit exception and should not require a separate price-confirmation action. Commercial registration and tax numbers are mandatory only for waste contracts. Creating a contract with an initial delivery must create one canonical work order, not parallel appointment and service-request dispatch tasks. Keep the planned/stable `location` separate from `currentLocation`; update the latter during transit and at completion so live state does not overwrite the contract destination.

**Why:** the user reported pricing friction, missing company identity on A4 contracts, unnecessary registration requirements for container rentals, duplicate dispatches, and stale warehouse locations.

**How to apply:** keep Node and Hostinger PHP behavior aligned, preserve scheduling metadata on the canonical work order, and render the current location in asset views without changing the contract site.
