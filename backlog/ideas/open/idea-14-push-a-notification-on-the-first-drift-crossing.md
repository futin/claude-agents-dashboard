---
id: idea-14
title: Push a notification on the first drift crossing
created: 2026-08-31
---

## Problem

A `drift` verdict is only visible on the Usage → Token value card, which is fetched
once per tab mount and unpolled. The whole point of measuring the exchange rate is to
notice when it moves — but a repricing that happens while nobody has the tab open is
invisible until the next time someone thinks to look, which could be weeks.

## Rough shape

Send one ntfy push through `server/lib/notify.ts` the first time a model's verdict
crosses into `drift`, and not again until it leaves. Deliberately excluded from
task-8, whose alerting decision was "card badge only".

The state this needs does not exist yet: the fit is computed on demand inside the
request handler, so nothing runs when no one is looking, and nothing remembers the
previous verdict. So this needs both a periodic evaluation (the recording timer is the
obvious host) and a small persisted last-verdict-per-model, or every evaluation would
re-push.

## Open questions

- Does it ride the existing `NotifyPolicy` events, or is an account-level alert a
  different category from the four session events? It is not about a session at all.
- What is the re-arm rule — verdict returns to `stable`, or a cooldown? A rate
  hovering at ±20% would otherwise flap.
- Should it wait for the baseline floors *and* a second consecutive drift evaluation
  before pushing, so one noisy fit cannot wake a phone?
