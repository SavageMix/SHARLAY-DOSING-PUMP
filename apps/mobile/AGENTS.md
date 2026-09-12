# Hard constraints

- PINNED to Expo SDK 54. Never upgrade `expo`, `react`, `react-native`, or any `expo-*` package. App Store Expo Go only supports SDK 54; upgrading breaks iPhone testing. If a package install tries to bump the SDK, stop and flag it.
- Never run `npm audit fix --force`.
- Design tokens live in `constants/Theme.ts` + `design/design-system.md` — all styling must use them.
- Never modify `apps/device` or `packages/shared` during UI prompts.
- The root `npm run typecheck` covers this app (`tsc --noEmit -p apps/mobile`) — it must stay clean. The Expo typed-routes file `.expo/types/router.d.ts` is generated; if it goes stale (route type errors for screens that exist), delete it and let `expo start` regenerate it.

# Expo docs

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.
