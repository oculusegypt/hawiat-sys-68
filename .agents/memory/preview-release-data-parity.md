---
name: Preview-release data parity
description: The user requires production release data to mirror the current preview after requested changes.
---

Treat the current preview database and content as the source of truth for release data. Build the package from a consistent snapshot of preview; never reuse an older staging database or archive, and do not silently filter or rewrite business/site content only in the release package. Preserve preview-to-release data parity after the user-requested database cleanup.

**Why:** The user explicitly said on 2026-10-28 that the same data visible in preview must be used in production, after clearing the requested service requests, customers, contracts, and related transactions.

**How to apply:** Rebuild release packages from the current preview state and compare important row counts/content before delivery. Keep only structural/runtime compatibility transformations that preserve the same displayed data. This source-of-truth rule does not authorize publishing or overwriting the live production database without the required per-action authorization.
