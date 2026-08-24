# Reef Doser

A commercial 4-channel aquarium dosing pump controller.

## Deployment

The live Raspberry Pi uses the repo at `/home/pi/SHARLAY-DOSING-PUMP` and runs the device server as `systemd` unit `reefdoser.service`.

Deploying from this repo:

```bash
PI_HOST=192.168.0.33 ./scripts/deploy-pi.sh
```

Important rules:

- Always rebuild `apps/device/dist` on the Pi (`tsc`) and restart `reefdoser.service` after any device-side change.
- `npm install` on the Pi must be scoped to avoid pulling the Expo mobile workspace and its ~684 dependencies:
  ```bash
  npm install -w apps/device -w packages/shared --omit=dev
  ```
- The database file lives in the service `WorkingDirectory`, i.e. `/home/pi/SHARLAY-DOSING-PUMP/apps/device/reef-doser.db`.
