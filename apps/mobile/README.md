# CloudConnect mobile (iOS & Android)

React Native (Expo dev client — native modules required) with:

| Capability | Implementation |
|---|---|
| Native calling UI | `react-native-callkeep` → **CallKit** (iOS) / **ConnectionService** (Android, self-managed) |
| Voice media | `@twilio/voice-react-native-sdk` (Opus, DTLS-SRTP); token from `GET /v1/telephony/token` |
| Incoming calls | PushKit VoIP push (iOS) / FCM high-priority (Android), registered by the Voice SDK |
| Push notifications | `expo-notifications`; device token registered via `POST /v1/devices` |
| Offline support | GET cache + mutation outbox in AsyncStorage, replayed on reconnect (`src/lib/api.ts`) |
| Secure storage | Refresh token in Keychain/Keystore (`expo-secure-store`), Face ID / biometrics unlock |
| CarPlay | Automatic for CallKit apps with `com.apple.developer.carplay-communication` entitlement |
| Siri | CallKit `INStartCallIntent` + App Intents (`ios/Intents`) |
| Widgets | WidgetKit extension (`ios/CloudConnectWidget`), data shared via App Group |
| Apple Watch | watchOS companion (`ios/CloudConnectWatch`) via WatchConnectivity |
| Video meetings | Opens the meeting room (LiveKit); native `@livekit/react-native` room is the next step |

```bash
pnpm install          # inside apps/mobile (not part of the root workspace)
npx expo prebuild     # generates ios/ & android/ native projects, then add the widget/watch targets in Xcode
eas build -p ios --profile production
eas build -p android --profile production
```

> The Swift extension targets (widget, intents, watch) must be added to the generated Xcode project
> (File → New → Target) and pointed at these sources; they are not wired by `expo prebuild`.
