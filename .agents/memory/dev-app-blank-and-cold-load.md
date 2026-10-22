---
name: Dev blank app and cold lazy-route load
description: Dev preview can go blank after the auto-run pre-deploy workflow starts a second dev server; cold lazy routes exceed 5s
---
A blank dev app was fixed by restarting "Start application"; likely cause (hypothesis) is the auto-run pre-deploy workflow starting a second dev server that corrupts the shared Vite optimize-deps cache.
**Why:** it looked like a code regression but was environmental.
**How to apply:** restart the app workflow before suspecting source. First cold dev load of a lazy route can take over 5s (contact picker ~14s), so wait for the heading before declaring it missing.
Also: any edit under scripts/, server/ or client/ invalidates the candidate build identity; to iterate on a browser cert, keep the registered script as a stub importing an untracked file outside those roots, then inline it and rebuild once. Chrome retries a reset POST by itself; use the truncated-response fault to show a visible failure.
