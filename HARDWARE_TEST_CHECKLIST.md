# Reef Doser — Hardware Test Checklist

Run these on the actual dosing rig. Check off each row and paste the results back. We fix anything that fails before shipping.

## Preconditions

- [ ] Pi is wired per the hardware map in `apps/device/src/gpio.ts`.
- [ ] Tubing is primed and outputs into a measuring container.
- [ ] `apps/device` is built and deployed via `scripts/deploy-pi.sh`.
- [ ] `reefdoser.service` is running (`sudo systemctl status reefdoser`).
- [ ] The LAN test page loads at `http://<pi-ip>:8000/`.

---

## 1. Direction check — every pump moves liquid the right way

| Pump | Expected direction | Observed | Pass/Fail |
|------|--------------------|----------|-----------|
| alk  | Into tank/return   |          |           |
| ca   | Into tank/return   |          |           |
| no3  | Into tank/return   |          |           |
| po4  | Into tank/return   |          |           |

**How to test:**
1. POST `/api/calibrate/start` for the pump.
2. Verify tubing moves water toward the tank (not back into the reservoir).
3. POST `/api/calibrate/stop` with `measuredMl: 0` to stop and discard the test.

---

## 2. Calibration accuracy — ±2%

| Pump | Steps/mL reported | Target volume (mL) | Measured volume (mL) | Error % | Pass/Fail |
|------|-------------------|--------------------|----------------------|---------|-----------|
| alk  |                   | 50.0               |                      |         |           |
| ca   |                   | 50.0               |                      |         |           |
| no3  |                   | 50.0               |                      |         |           |
| po4  |                   | 50.0               |                      |         |           |

**How to test:**
1. POST `/api/calibrate/start`.
2. Dispense a known volume (start with 50 mL).
3. POST `/api/calibrate/stop` with the measured mL.
4. Record the computed `stepsPerMl` and error.

---

## 3. EN safety — `kill -9` mid-dose releases EN

| Step | Expected | Observed | Pass/Fail |
|------|----------|----------|-----------|
| Start a dose/calibration so EN is LOW (~0V). | EN LOW |          |           |
| `sudo kill -9 <reefdoser-pid>` from another shell. | Process dies |          |           |
| Measure EN pin within 1 s. | EN HIGH (~3.3V) |          |           |
| Check `sudo systemctl status reefdoser` — service restarts. | Restarted |          |           |

**How to test:**
1. Start calibration or a large dose.
2. While running, run `pgrep -f "node.*index.js"` to get the PID.
3. `sudo kill -9 <pid>`.
4. Probe the EN pin immediately.

---

## 4. Reboot/power-cut safety — no double-fire after reboot

| Step | Expected | Observed | Pass/Fail |
|------|----------|----------|-----------|
| Create an enabled schedule due every minute (`* * * * *`). | Schedule created |          |           |
| Let it fire once. | One dose event in `/api/history` |          |           |
| While the next occurrence is due, reboot the Pi (`sudo reboot`). | Reboots |          |           |
| Wait for the due time to pass during reboot. | — |          |           |
| After boot, check `/api/history`. | Exactly one event for that minute, not two |          |           |
| Check `/api/schedules` `lastRunAt`. | Matches the event's `startedAt` |          |           |

---

## 5. Volume-limit safety — 1000 mL request rejected

| Step | Expected | Observed | Pass/Fail |
|------|----------|----------|-----------|
| POST `/api/dose` with `{ pumpId: "alk", volumeMl: 1000 }`. | HTTP 400 or 202 then failed event |          |           |
| Check `/api/history`. | No completed 1000 mL dose |          |           |

---

## 6. Queue safety — two simultaneous requests queue correctly

| Step | Expected | Observed | Pass/Fail |
|------|----------|----------|-----------|
| POST two doses in quick succession: `{alk, 10mL}` and `{ca, 10mL}`. | Both return jobIds |          |           |
| Watch `/api/status` for 20 s. | `queueDepth` goes 2 → 1 → 0; only one dose runs at a time |          |           |
| Check `/api/history`. | Two completed events with non-overlapping `startedAt`/`finishedAt` |          |           |

---

## General notes / failures

Paste any failures, unexpected EN behaviour, or calibration numbers below:

```
<your notes here>
```
