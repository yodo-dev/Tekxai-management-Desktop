# TekXAI Desktop Agent — Enterprise Rollout Guide

Three independent mechanisms — Release Channels, Staged Rollout, and
Enterprise Deployment Rings — combine into one recommended playbook for
rolling a new version out to the whole company safely. Each is documented
in full in `AUTO_UPDATE_SYSTEM.md`; this guide is the "how they fit
together" companion.

## The three mechanisms, and what each one is actually for

| Mechanism | Answers | Granularity |
|---|---|---|
| **Release Channel** (`stable`/`beta`/`internal`/`development`) | Which *pool of installs* can ever see this release at all | Coarse — an install is permanently in one channel until changed |
| **Staged Rollout** (10/25/50/100%) | Of the installs that *can* see it, what fraction see it *right now* | A random, stable-per-user percentage — same person always lands in the same bucket for a given release |
| **Deployment Rings** (business unit/department/team/user targets) | Which *specific group* this release is restricted to, if any | Deliberate, not random — untargeted = everyone in channel |

These stack, not substitute for each other: a `stable`-channel release at
25% rollout targeted to the "Engineering" department reaches only
Engineering employees on the stable channel, and even then only 25% of them
at this moment (bypassed entirely if the release is also marked
`force_update`).

## Recommended playbook for a routine feature release

1. Publish to `stable` at **10%** rollout, untargeted.
2. Watch Update Analytics' failed-update count and Desktop Diagnostics for
   ~a day among that 10%.
3. No red flags → widen to 25% → 50% → 100%, watching between each step
   (Release History's rollout dropdown, no re-publish needed).
4. Red flags at any point → stop widening, investigate
   (`UPDATE_TROUBLESHOOTING_GUIDE.md`), Rollback or Emergency Disable if
   needed (`ROLLBACK_GUIDE.md`).

## Recommended playbook for a larger or riskier change

1. Publish to the `internal` channel first (only installs an admin has
   explicitly moved to that channel — today a direct DB action, see
   `AUTO_UPDATE_SYSTEM.md`'s "Known limitations," no in-app switcher yet).
2. Once internal testers confirm it's good, publish the *same build* fresh
   to `stable`, restricted via a deployment-ring target to a **Pilot
   Group** — e.g. a `team` target pointing at a team created specifically
   to hold pilot volunteers, or a `department`/`business_unit` target if an
   existing org unit is a natural pilot population.
3. Once the pilot group reports clean for a period you're comfortable with,
   remove the target (Release History → Targets → remove each row) so the
   release reaches everyone in `stable`, still respecting whatever staged
   rollout percentage it's at — then widen rollout normally per the routine
   playbook above.

## Deployment-ring usage patterns

These are all just target rows against the same four types
(`business_unit`/`department`/`team`/`user`) — not separate features:

| Pattern | How to express it |
|---|---|
| Pilot Group | A `team` (or `department`) target pointing at a team/department created to hold volunteers |
| IT Team | A `team` target pointing at the actual IT team's id |
| Management | A `department`/`team` target, or several `user` targets if management doesn't map to one clean org unit |
| Developers | Same — whichever existing org unit (team/department) represents Engineering/Developers |
| Specific Business Unit | A `business_unit` target with the value matching `users.business_unit` (e.g. `"ERP"`, `"CRM"`, `"HR"`) |
| Specific Department | A `department` target with that department's id |
| Individual employee(s) | One or more `user` targets, each with that user's id — equivalent to (and layered on top of) the existing per-employee Force Update action, but declarative on the release itself rather than a one-off admin click |

Multiple target rows on the same release are OR'd — "Pilot Group OR IT
Team" is two rows, not a new concept.

## What this doesn't do (yet)

- No AND/exclude logic ("ERP business unit EXCEPT the Interns team") — only
  OR-across-rows. Additive if ever needed, not built today.
- No in-app channel switcher — moving an install to `beta`/`internal`/
  `development` is a direct database action against `desktop_installations.channel`
  today.
- No UI to browse "which employees does this target actually resolve to"
  before publishing — the target is evaluated per-request against each
  employee's live `business_unit`/`department_id`/team memberships, not
  pre-computed into a list. For a business_unit/department/team target,
  cross-check against Directory/Org Chart if you need to know the exact
  membership in advance.
