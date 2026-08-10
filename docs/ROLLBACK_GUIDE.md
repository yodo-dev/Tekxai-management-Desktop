# TekXAI Desktop Agent — Rollback Guide

Two distinct actions exist for "this release shouldn't be latest anymore" —
picking the wrong one either under- or over-reacts to the actual problem.
Both are available from Release History in Administration → Desktop
Management, and both require `SUPER_ADMIN`.

## Rollback vs. Emergency Disable — which one?

| | **Rollback** | **Emergency Disable** |
|---|---|---|
| Use when | The release just isn't good — a regression, an unwanted change, "we shouldn't have shipped this yet" | The release is actively harmful right now — crashes, data loss, a security issue |
| Effect on future checks | Excluded from ever being "latest" again | Same |
| Effect on installs already running it | **Nothing** — they stay on it until they separately update to whatever's next | **Force-updated away from it** on their next telemetry check (within 30 minutes), regardless of `minimum_version` |
| Requires a reason | No | Yes — shown in Release History, this is for the "actively wrong" case specifically |
| Endpoint | `POST /desktop/releases/:id/rollback` | `POST /desktop/releases/:id/disable` with `{"reason": "..."}` |

If you're unsure which applies: if you'd be comfortable with employees
staying on the bad version until their next routine update, use Rollback.
If leaving anyone on it for even a few more minutes is a problem, use
Emergency Disable.

## What happens mechanically (no follow-up steps needed either way)

Both actions just flip `desktop_releases.status` away from `'ACTIVE'`
(`'ROLLED_BACK'` or `'DISABLED'`). Every "what's latest" lookup — the
public `/desktop/latest-version` check, the internal
`find_latest_active_release` helper used for force-flag clearing and
outdated-employee computation — filters `status: 'ACTIVE'` already. The
moment a release stops being ACTIVE, the next-newest ACTIVE release in the
same channel automatically becomes "latest" again for every subsequent
check. There is no separate "restore the previous version" step, no cache to
bust, no re-publish needed — this is why the system was designed around a
status filter instead of a "current pointer" that would need active
updating on every rollback (see `AUTO_UPDATE_SYSTEM.md`'s architecture
notes).

A rolled-back or disabled release stays visible in Release History (audit
trail) — it isn't deleted, and there's no delete endpoint for a release by
design.

## Un-disabling / un-rolling-back a release

There isn't one. If you disabled or rolled back a release by mistake, or
the underlying problem gets fixed, publish it again as a fresh version
(even reusing the same version number is allowed once the old row is no
longer the "active" one — `desktop_releases.version` uniqueness is
per-row, not per-lifecycle-state). This is a deliberate simplification: an
"un-disable" action would need to re-derive whether it should still be
"latest" against whatever's been published since, which is exactly what a
fresh publish already does correctly with zero special-case logic.

## Deployment-ring-targeted releases

Rollback/Disable apply to the release as a whole — if it was restricted to
a specific business unit/department/team (see `ENTERPRISE_ROLLOUT_GUIDE.md`),
rolling it back or disabling it removes it from *that group's* view of
"latest," the same way it would for an untargeted release affecting
everyone. The target rows themselves aren't touched — they're still visible
in the release's Targets modal for reference, just no longer relevant since
the release itself is no longer ACTIVE.

## Verifying a rollback/disable worked

`GET /desktop/latest-version?channel=<channel>` (no auth needed) should now
return the previous release's version, not the one you just rolled back —
this is the fastest live check, and exactly what every installed app itself
calls. Update Analytics' "Pending Updates" count will also rise if the
newly-restored "latest" is higher than what most employees are currently on.
