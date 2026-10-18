---
name: Serper lookup memory and matcher rules
description: How repeat paid Serper lookups are suppressed, and the discipline needed when changing the matcher.
---
Negative Serper outcomes are remembered per business (table sfp_serper_lookup_memory) with finite expiries, and excluded inside the selection SQL (before LIMIT) only while the input fingerprint AND SERPER_MATCHER_RULE_VERSION still match.

**Why:** production repeatedly bought the same unchanged no-match/rejected lookups; the only prior guard was a 24h provider_operations cooldown, which also masks memory expiry in tests (age provider_operations in certification).

**How to apply:**
- Bump SERPER_MATCHER_RULE_VERSION whenever scoring, geography checks, query construction or fallback policy can change an outcome; that reopens every business judged under the old rule.
- Provider failure is its own class with a 1h expiry; blocked outcomes record nothing. Never fold them into no_match.
- The unlabeled (no-vertical) discovery scope is closed unless system_settings sfp_serper_unlabeled_discovery has enabled plus positive perRun/daily request allowances; allowance is checked before every request, including a lookup's second request. It never writes a vertical.
- Replaying a completed stage idempotency key after the candidate pool changed fails with a payload-hash mismatch; this is pre-existing, not a memory bug.
- Pilot certification and the zero-yield cooldown test have unrelated pre-existing failures on this tree.

## Name matcher tokenization (rule 4)
- The old scorer split on every non-alphanumeric, so possessives ("Tyson's" -> "tyson"+"s"), "&" and hyphens produced false `name_mismatch` for the same name spelled differently. Scoring now folds possessives/plurals, treats "&" as "and", ignores and/of/the, and takes the better of hyphen-split and hyphen-joined readings. Address overlap still uses the plain tokenizer.
- Most remaining rejections are real: many registry LLCs have no web or map listing, so the provider returns other businesses. Do not read a ~10% accepted rate as proof of a matcher bug without checking spelling variants first.
- Weakness left as is: full ZIP/city agreement plus 2 of 3 shared tokens reaches the 0.50 threshold ("Tri County Auto" vs "Tri-Coast Auto").
**Why:** the owner asked why discovery yielded ~10%; sampled rejected names showed variant-spelling cases. **How to apply:** any scoring change bumps SERPER_MATCHER_RULE_VERSION, which reopens every rejected business for a paid re-lookup (~1 credit each).
