---
name: PHP API test harness
description: Test constraints for PHP route-level behavior in this workspace's runner.
---

Avoid invoking a PHP API route from a nested PHP CLI test through `proc_open`; in this Replit runtime, a spawned PHP child can stall in a stopped/ptrace state.

**Why:** A route-level test attempt hung without completing, while the isolated PHP helper tests and the Node lifecycle harness were able to run independently.

**How to apply:** Prefer testing pure PHP helpers in-process or exercising the API through an existing isolated Node harness. If a nested process is unavoidable, keep it bounded and monitor its exit rather than waiting indefinitely.
