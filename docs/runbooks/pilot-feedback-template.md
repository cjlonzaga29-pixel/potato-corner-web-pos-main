# Pilot Feedback Template

## 1. Purpose and Scope

Lightweight feedback collection for the Phase 20 pilot branch deployment (Task 15 of `docs/superpowers/plans/2026-07-19-phase20-pilot-deployment.md`). It gives pilot-branch staff and the on-duty supervisor a simple, no-login, no-app way to report issues, friction, or suggestions during the 3-day pilot window, without requiring any new backend infrastructure or libraries.

**Why a doc instead of an in-app button:** pilot POS terminals are shared Android tablets that are not guaranteed to have a personal email client configured, so a `mailto:` link in the app could silently fail to open for exactly the non-technical staff who need it most. A printed/shared fillable template that gets submitted by whatever channel is already working (personal phone, supervisor's email, or verbally relayed to the on-call contact) has no such dependency and needs zero code changes to be live for Day 1.

## 2. Who Uses This

- **Staff (cashiers):** fill out one copy per shift, or immediately when something goes wrong, whichever is sooner.
- **Supervisors:** fill out one copy per day covering anything staff flagged verbally plus their own observations, and are responsible for making sure every staff-reported issue actually gets submitted.

## 3. How to Submit

**Email address: `TBD — fill in before Task 16 cutover`** (recommend a shared inbox monitored by the on-call contact from `docs/runbooks/pilot-on-call.md`, not a personal address).

1. Copy the template in §5 into an email, a messaging app note, or fill in a printed copy.
2. Send/hand it to the on-duty supervisor before end of shift.
3. Supervisor forwards all shift copies to the feedback email address above, once per day minimum.
4. Anything marked **Severity: Critical** should also be raised immediately by phone to the on-call contact — do not wait for the daily digest.

## 4. Severity Guide

| Severity | Meaning | Example |
|---|---|---|
| Critical | Blocks selling or corrupts data; needs the on-call contact now | Register won't total a sale, wrong VAT amount charged |
| High | Workaround exists but it's painful | Clock-in requires 3 attempts every time |
| Medium | Annoying, not blocking | Confusing button label |
| Low | Cosmetic or a nice-to-have | Would like a bigger font |

## 5. Feedback Template

Copy everything below the line into an email or note per submission.

---

```
PILOT FEEDBACK — [Branch name] — [Date] — [Shift: AM/PM]

Submitted by: [Name / role — staff or supervisor]

Severity: [Critical / High / Medium / Low]

What happened:
[Describe what you were doing and what went wrong or felt off]

What you expected instead:
[One or two lines]

Screen/screenshot (if available):
[Attach or describe]

Anything else:
[Optional]
```

---

## 6. Pre-Go-Live Actions

- [ ] Fill in the feedback email address in §3 (recommend it match or forward to the on-call contact in `docs/runbooks/pilot-on-call.md` §3).
- [ ] Print or share this template with pilot branch staff and supervisor before Day 1.
- [ ] Confirm supervisor understands the daily-forward responsibility in §3.
