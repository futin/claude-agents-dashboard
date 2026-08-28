---
id: bug-3
title: serveStatic guard escapes clientDist via dist-prefixed sibling
created: 2026-08-27
tags: security, server
---

## Symptom

`serveStatic`'s traversal guard does not actually confine served files to `client/dist`.
Any request path that resolves into a *sibling* directory whose name merely begins with
`dist` passes the check and is served, instead of falling back to `index.html`.

Not exploitable as the repo stands — no such sibling directory exists under `client/`. It
becomes live the moment a `client/dist-old`, `client/dist.bak` or `client/dist-ssr` build
artifact appears. The server binds all interfaces, so the listener is not local-only.

## Repro

```bash
node -e "const p=require('path');const d=p.join(process.cwd(),'client','dist');console.log(p.join(d,'../dist-secret/passwd').startsWith(d))"
```

Prints `true`. In a running prod server (`pnpm start`), create `client/dist-secret/passwd`,
then GET a URL whose path resolves there — it is served rather than rejected.

## Affects

- server/index.ts:83 — the guard `!filePath.startsWith(clientDist)`
- server/index.ts — `clean` (strips leading slashes only) and the `path.join(clientDist, clean)` above it

## Cause

Two defects compound:

1. `clientDist = path.join(process.cwd(),'client','dist')` has no trailing separator, so
   `startsWith` is a bare string-prefix test. `.../client/dist-secret/x` is a legitimate
   prefix match for `.../client/dist`.
2. Raw `req.url` is never decoded or normalized before the join. `clean` only strips leading
   slashes, and `path.join` then collapses the `..` segments itself.

Verified by two independent auditors and confirmed by a skeptic pass: nothing upstream strips
`..` or adds a separator before the comparison.

## Fix

Compare against `clientDist + path.sep` (and allow the exact-directory case), and decode
`req.url` before joining so encoded traversal (`%2e%2e`) is handled too. Add a test covering
a `dist`-prefixed sibling and an encoded `..`; make it fail without the fix before landing.
