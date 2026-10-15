---
name: Useful-list evidence
description: Qualify CRM performance against visible hydrated content, not navigation or shell readiness.
---
Require a useful-list timing condition to identify actual hydrated record content and verify it is visible within the available workspace.

**Why:** Shell headings rendered before usable data, and a persisted stage accepted by the existing backend was absent from the legacy Board/List stage enumeration. A DOM node in an offscreen horizontal lane also does not establish a usable first view.

Qualify cache conditions from the actual network configuration, not from repeated visits in the same browser process. Measure local input-to-render after focus/selection and at the real text input; retain failures against the original thresholds.

**Why:** A receipt called repeated navigations warm even though HTTP caching was disabled. Timing focus, scrolling and selection as text-input latency measures a different interaction.

Real-pointer evidence requires a visible, unobstructed target after scrolling and layout settlement. Text-input evidence must confirm the intended input owns focus before selecting or typing text.

**Why:** A pointer captured during modal scrolling/layout changes dismissed the dialog instead of focusing its search field; Ctrl+A then selected the page, producing a misleading picker failure.

Wait for both opening geometry and closing modal presence to settle before the next real-pointer action. A loaded field is not yet an interactable field; an Escape event is not yet restored background interaction. Check connected focus return when a menu trigger has detached.

**Why:** Real Chromium input reached a Sheet while its field was still moving from outside the viewport. Another run reached the board after Escape while the exiting Sheet still held the body pointer lock. Neither symptom alone established a persistent application defect.

Native-button keyboard acceptance must include Chromium's character event, not just keydown/keyup. For CDP Enter, supply carriage-return text/unmodifiedText; retain actual focus and one-click/effect checks.

**Why:** A private no-database Chromium probe showed Enter without text generated keydown/keyup and zero clicks, while carriage-return text generated keypress and exactly one native click. Radix's keydown-driven controls can pass while native buttons silently remain untested.

**How to apply:** Read the rendered component's actual selectors instead of inventing them, require real rows or cards with explicit visibility, and declare volume, hardware, network and cache conditions. Keep navigation timing, local-input timing and whole-volume acceptance separate.

Compare rendered record identifiers with the page's actual returned identifiers; a broad semantic-tag count is not a record count.

**Why:** A composite review panel contained both source-recovery articles and actual review records. Counting all articles rejected a correctly hydrated page, while an earlier shell-only capture missed that records were still loading.

**How to apply:** Wait for the destination's hydrated records, verify their identifiers and next-page non-overlap, then capture the visible result. Do not certify the record collection from its parent panel or loading shell.

Full-document navigation and reload proof must distinguish the destination document from the previous one before checking a shared heading, tab or reader.

**Why:** Consecutive Outreach destinations share headings and tab selectors. A text/selector wait could return against the old document, then reject the correct URL-backed selection before the navigation committed.

**How to apply:** For full navigations require a changed document time origin and complete document, then wait for destination-specific hydration and selection. Treat same-document SPA/history changes separately; a common heading alone is never navigation completion evidence.
