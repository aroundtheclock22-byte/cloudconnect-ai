import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { ActivityIndicator, useColorScheme, View } from 'react-native';
import { api, restoreSession } from './lib/api';
import { registerVoice, setupCallKeep } from './lib/calling';
import { CallsScreen, ContactsScreen, KeypadScreen, LoginScreen, MeetingsScreen, MessagesScreen, VoicemailScreen } from './screens';

const Tab = createBottomTabNavigator();
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }) });

export default function App() {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const scheme = useColorScheme();

  useEffect(() => {
    (async () => {
      const ok = await restoreSession();
      if (ok && (await LocalAuthentication.hasHardwareAsync())) {
        const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock CloudConnect' });
        if (!r.success) return setState('out');
      }
      setState(ok ? 'in' : 'out');
    })();
  }, []);

  useEffect(() => {
    if (state !== 'in') return;
    (async () => {
      await setupCallKeep();
      await registerVoice().catch(() => undefined);
      const { status } = await Notifications.requestPermissionsAsync();
      if (status === 'granted') {
        const push = await Notifications.getDevicePushTokenAsync();
        await api('/v1/devices', { body: { kind: push.type === 'ios' ? 'ios' : 'android', name: 'Mobile app', pushToken: String(push.data) } }).catch(() => undefined);
      }
    })();
  }, [state]);

  if (state === 'loading') return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  if (state === 'out') return <LoginScreen onLogin={() => setState('in')} />;
  return (
    <NavigationContainer theme={scheme === 'dark' ? DarkTheme : DefaultTheme} linking={{ prefixes: ['cloudconnect://'], config: { screens: { Keypad: 'call/:number?', Voicemail: 'voicemail', Messages: 'messages' } } }}>
      <Tab.Navigator screenOptions={{ tabBarActiveTintColor: '#2550eb' }}>
        <Tab.Screen name="Calls" component={CallsScreen} />
        <Tab.Screen name="Messages" component={MessagesScreen} />
        <Tab.Screen name="Keypad" component={KeypadScreen} />
        <Tab.Screen name="Voicemail" component={VoicemailScreen} />
        <Tab.Screen name="Contacts" component={ContactsScreen} />
        <Tab.Screen name="Meetings" component={MeetingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
