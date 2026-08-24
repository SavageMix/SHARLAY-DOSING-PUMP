# Hard constraints

- PINNED to Expo SDK 54. Never upgrade `expo`, `react`, `react-native`, or any `expo-*` package. App Store Expo Go only supports SDK 54; upgrading breaks iPhone testing. If a package install tries to bump the SDK, stop and flag it.
- Never run `npm audit fix --force`.
- Design tokens live in `constants/Theme.ts` + `design/design-system.md` — all styling must use them.
- Never modify `apps/device` or `packages/shared` during UI prompts.

# Expo docs

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.
