---
name: Contract issuance and live location
description: Contract pricing, conditional business identifiers, dispatch creation, and container location behavior.
---

For container contracts, manual amount entry is the default; dynamic pricing is an explicit exception and should not require a separate price-confirmation action. Commercial registration and tax numbers are mandatory only for waste contracts. Creating a contract with an initial delivery must create one canonical work order, not parallel appointment and service-request dispatch tasks. Work orders cover container and waste contracts only; assetless cleaning contracts do not need driver dispatch. Keep the planned/stable `location` separate from `currentLocation`; update the latter during transit and at completion so live state does not overwrite the contract destination. Keep GPS coordinates available for maps, but do not display numeric coordinates in visible address or driver-proof text.

**Why:** the user reported pricing friction, missing company identity on A4 contracts, unnecessary registration requirements for container rentals, duplicate dispatches, and stale warehouse locations; they also want GPS to remain usable without exposing raw coordinate strings in the interface. The user confirmed dispatch should cover container and waste contracts, not cleaning contracts without containers.

**How to apply:** keep Node and Hostinger PHP behavior aligned, preserve scheduling metadata on the canonical work order, check contract type and asset linkage before creating dispatch, use coordinates internally for map links/embeds, and render the current location in asset views without changing the contract site.
