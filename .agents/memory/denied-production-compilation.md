---
name: Denied production compilation
description: Why CI production compiler descendants need a separate deny-only purpose from database and browser fixture runtimes.
---

Keep production compiler purpose separate from ordinary certification runtime. A compiler-only allowance must retain fatal HTTP/provider denial, prohibit network-origin and loopback allowances, and deny TCP connections. It must not permit application/database/session fixtures to run in production mode.

**Why:** The production build passed standalone but failed under the normal denied CI runner: the build changed NODE_ENV and toolchain-inspection descendants inherited NODE_OPTIONS with a test-only preload. Turning off the preload would hide the failure by removing provider isolation.

**How to apply:** Verify the exact denied writable-build path, not only a standalone production build. Exercise both positive compiler boot and negative production-runtime/network-allowance cases. Keep business artifacts compiled for production while owned database/browser/session runtime remains test-only.
