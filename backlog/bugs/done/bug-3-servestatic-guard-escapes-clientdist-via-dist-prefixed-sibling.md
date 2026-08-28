---
id: bug-3
title: serveStatic guard escapes clientDist via dist-prefixed sibling
created: 2026-08-27
tags: security, server
started: 2026-08-28
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

## Outcome

2026-08-28 — Fixed on branch `fix/static-path-guard`. Not committed; the working tree is
shared with a parallel session's in-flight permission-dedupe work, so staging was left to
the user.

The guard and the decode had to land together, and the report understated why: as it stood,
`%2e%2e` was **inert**, not exploitable. Nothing decoded it, so it stayed a literal path
segment inside `client/dist` and fell through to `index.html`. Adding `path.sep` alone would
have been correct; adding decoding alone would have *armed* encoded traversal against the
broken prefix test. Decoding goes through the existing `decodePath`, not `decodeURIComponent`
— a raw call reintroduces the synchronous `URIError` process-kill that `decodePath` exists to
prevent.

Extracted the resolution into an exported, socket-free `resolveStaticPath(urlPath, root)`;
`serveStatic` now just calls it. New `test/static-path.test.ts` (7 cases), registered in
`test/run-all.ts`. Documented the invariant in `docs/overview.md`, which also corrected a
wrong claim there: the static catch-all answers in **dev** too, not "production only".

### Mutation proof — the tests discriminate

Exported the *old* logic under the new name first. 4 of 7 cases failed, including the escape:

```
  ✗ a dist-prefixed sibling directory is refused, not served
    ../dist-secret/passwd must fall back to index.html
+ actual - expected
+ '/srv/app/client/dist-secret/passwd'
- '/srv/app/client/dist/index.html'
  ✗ percent-encoded traversal is decoded and then refused
  ✗ a percent-encoded name inside the root decodes to the real file
  ✗ malformed percent-encoding falls back instead of throwing URIError
  3 passed, 4 failed
```

### Live repro, real server, both sides

`client/dist-secret/passwd` planted with the body `ESCAPED-THE-DIST-ROOT`, server on
`PORT=4273`, requests unauthenticated. On HEAD's code:

```
$ curl -s -w "\n[http=%{http_code} type=%{content_type}]\n" --path-as-is \
    "http://localhost:4273/../dist-secret/passwd"
ESCAPED-THE-DIST-ROOT

[http=200 type=application/octet-stream]

$ curl --path-as-is "http://localhost:4273/%2e%2e/dist-secret/passwd"
<!DOCTYPE html>…          # inert before the fix, as described above
```

With the fix, both return `index.html`, and the malformed-escape probe does not kill the
process:

```
--- /../dist-secret/passwd ---      <!DOCTYPE html>…
--- /%2e%2e/dist-secret/passwd ---  <!DOCTYPE html>…
--- /%ZZ (crash probe) ---          http=200
--- server alive? ---               http=200
```

The planted directory was removed and the server stopped afterwards.

### Suite

```
$ npx tsx test/run-all.ts
=== index.ts resolveStaticPath ===
  ✓ ordinary asset paths resolve inside the dist root
  ✓ the SPA fallback covers the root and the query string is stripped
  ✓ a dist-prefixed sibling directory is refused, not served
  ✓ percent-encoded traversal is decoded and then refused
  ✓ plain traversal well outside the root still falls back
  ✓ a percent-encoded name inside the root decodes to the real file
  ✓ malformed percent-encoding falls back instead of throwing URIError
  7 passed, 0 failed
…
ALL PASS

$ npx tsc --noEmit
typecheck: clean
```

**Not verified:** Windows behaviour. The `path.sep` comparison is correct there by
construction, but nothing was run on Windows, and `path.win32` handles drive-relative paths
(`C:foo`) and UNC prefixes in ways these POSIX-rooted cases never exercise.
