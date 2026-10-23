---
name: Drizzle begin failure leaks the client
description: drizzle-orm 0.45 node-postgres runs BEGIN outside its try/finally; server/db.ts overrides pool transaction to release it
---
A failed BEGIN (connection terminated while checked out) never released the client in stock drizzle, producing a db:long_checkout ERROR every 5s until restart (hundreds of error logs, monitoring alert).

**Why:** the observer's sampler keeps reporting any checkout that is never released.
**How to apply:** keep the releasing transaction override in server/db.ts; on a drizzle upgrade re-check whether upstream fixed it before removing. Recurring db:long_checkout with transactionOpen:false and lastQuery begin means a leaked client, not a slow query.
