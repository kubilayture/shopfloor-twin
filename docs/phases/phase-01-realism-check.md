# Phase 01 – Realism check of a simulated week

Exit criterion 5 of Phase 1: the owner checks the simulated behaviour against factory experience (plan section 12, realism risk). This page describes the golden week in numbers and lists every modelling choice that should be confirmed or corrected. Reply per numbered question with "OK", or with the value or behaviour you would expect. Corrections become config or model changes with a golden snapshot update.

## The week

Golden scenario `week-01`: seed 20261012, default configuration, Monday 2026-10-12 06:00 to Monday 2026-10-19 06:00 (Istanbul), with every Phase 1 model on. Reproduce with `pnpm sim:headless --seed 20261012 --days 7 --out runs/week-01`.

**Output.** 2,200 blanks started (the full weekly program: 1,500 VB-100 and 700 VB-200). 2,189 good parts finished (1,493 VB-100, 696 VB-200) and 11 scrapped at OP10 (`DIMENSIONAL`).

**Hours per state** (week = 168 h; 112.5 h of it are production time inside shifts):

| Machine | Running | Stopped | Down | Setup | Blocked | Starved | Idle | PlannedStop | Off  |
| ------- | ------- | ------- | ---- | ----- | ------- | ------- | ---- | ----------- | ---- |
| CNC-01  | 82.2    | 1.9     | 1.0  | 0.7   | 19.2    | –       | 7.7  | 7.4         | 48.0 |
| CNC-02  | 82.1    | 2.0     | –    | 0.7   | 20.2    | –       | 7.5  | 7.5         | 48.0 |
| WSH-01  | 36.5    | 0.2     | –    | –     | 67.1    | 8.8     | –    | 7.5         | 48.0 |
| ASM-01  | 105.8   | 2.6     | –    | –     | –       | 4.1     | –    | 7.5         | 48.0 |
| LKT-01  | 55.1    | 0.6     | –    | –     | –       | 56.7    | –    | 7.5         | 48.0 |
| PCK-01  | 18.2    | 0.9     | –    | –     | –       | 93.4    | –    | 7.5         | 48.0 |

**Events in the week**

- Breakdowns: 2, both on CNC-01: one `SPINDLE-OVERLOAD`, one `COOLANT-PRESSURE`. Together they cost 1.0 h of repair (28 and 30 min); a technician was free both times, so there was no waiting.
- Minor stops: ASM-01 319, CNC-01 168, CNC-02 184, LKT-01 63, PCK-01 32, WSH-01 15.
- Changeovers: 1 per CNC (VB-100 → VB-200, 25 min). Tool changes: 2 per CNC (8 min each).
- Leak test: first-test failure 0.73%; 16 parts reworked, all of which passed the second time.
- Operators: 1 absence in 15 shifts; ASM-01 was always staffed.
- Material: no shortage. About 200–300 of each component are left at the end of the week.

**Reading.** ASM-01, the manual bottleneck, works 105.8 of 112.5 production hours. Its losses are minor stops (2.6 h) and starvation (4.1 h). Almost all of the starvation (about 4.0 h) is on Saturday morning, after the weekly program is finished and the upstream stations have run dry; only 5 minutes are at the Monday start. The CNCs are blocked about 20 h because they can make parts faster than ASM-01 can assemble them, and idle about 7.5 h at the end of the week because the program is done.

## Questions

Defaults are what the model does now. Values are in `config/plant/*.yaml`; behaviours are in `docs/simulation-model.md`.

### Rates and durations

1. **CNC breakdowns:** spindle overload with a Weibull scale of 160 running hours, coolant pressure 60 h; repairs with a median of 45 min and 15 min. That is about one breakdown per CNC every 2–3 days. Realistic for horizontal machining centres?
2. **Minor stops:** CNCs 2 per running hour, about 40 s each (door interlock, chip jam); manual assembly 3 per hour, about 30 s; leak tester 1 per hour; packing 1.5 per hour, about 90 s (label out). Too many, too few?
3. **Maintenance technicians:** 2 for the whole line. Plausible for this cell size?
4. **Changeover:** 25 min (from the plan), tool change 8 min after 400 parts. Plausible?
5. **OP10 scrap:** 0.2% with a new tool, 0.5% at 80% wear, 5% at end of life; about 0.5–0.8% on average. Plausible?
6. **Leak test:** mean 2.0 Pa/min, sigma 0.45, limit 3.2, drift 0.04 per day, calibration every 7 days, giving 0.4–2% first-test failures. Plausible?
7. **Operators:** speed factors 0.95–1.15, 3% absence per shift, 2 operators per shift qualified for ASM-01. Plausible?

### Behaviour

8. **Cycle times** have their _mean_ at the ideal time (log-normal, CV 3% for CNC, 12% for manual assembly), so single cycles are sometimes faster than ideal. Should the ideal time instead be a _minimum_, with every cycle at or above it?
9. **Breaks** stop the whole line, CNCs included. Should CNCs keep running unattended through breaks?
10. **Repairs and changeovers continue through breaks**, and an interrupted minor stop isn't resumed after the break. OK?
11. **Weekly start:** CNCs start Monday already set up for their first campaign; the program counts blanks, so scrap lowers output, with no scrap allowance. OK?
12. **Rework:** goes through a separate rework queue at ASM-01 (not back into the OP20→OP30 buffer) and gets a new seal kit, but not a new spool. OK?

When all answers are in, the Phase 1 tag (`phase-01`) is created.
