/**
 * Native calling: Twilio Voice RN SDK for media (Opus/SRTP) + react-native-callkeep, which bridges
 * to CallKit on iOS (lock-screen UI, CarPlay, Siri "call … with CloudConnect", Bluetooth) and
 * ConnectionService on Android (system dialer UI, Android Auto, Wear OS).
 * Incoming calls arrive as PushKit VoIP pushes (iOS) / FCM high-priority data messages (Android).
 */
import { Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import { Voice, Call, CallInvite } from '@twilio/voice-react-native-sdk';
import { api } from './api';

export const voice = new Voice();
const calls = new Map<string, Call>();
const invites = new Map<string, CallInvite>();

export async function setupCallKeep() {
  await RNCallKeep.setup({
    ios: { appName: 'CloudConnect', supportsVideo: true, maximumCallGroups: '2', maximumCallsPerCallGroup: '3', includesCallsInRecents: true },
    android: {
      alertTitle: 'Calling accounts', alertDescription: 'Allow CloudConnect to manage calls', cancelButton: 'Cancel', okButton: 'OK',
      selfManaged: true, additionalPermissions: [],
      foregroundService: { channelId: 'ai.cloudconnect.calls', channelName: 'Ongoing calls', notificationTitle: 'CloudConnect call in progress' },
    },
  });
  RNCallKeep.setAvailable(true);
}

export async function registerVoice() {
  const { token } = await api('/v1/telephony/token');
  await voice.register(token); // registers the device for incoming-call pushes
}

export function registerBackgroundHandlers() {
  voice.on(Voice.Event.CallInvite, (invite: CallInvite) => {
    const uuid = invite.getCallSid();
    invites.set(uuid, invite);
    RNCallKeep.displayIncomingCall(uuid, invite.getFrom(), invite.getFrom(), 'number', false);
  });
  RNCallKeep.addEventListener('answerCall', async ({ callUUID }) => {
    const inv = invites.get(callUUID);
    if (inv) { calls.set(callUUID, await inv.accept()); invites.delete(callUUID); }
  });
  RNCallKeep.addEventListener('endCall', async ({ callUUID }) => {
    invites.get(callUUID)?.reject(); invites.delete(callUUID);
    calls.get(callUUID)?.disconnect(); calls.delete(callUUID);
  });
  RNCallKeep.addEventListener('didPerformSetMutedCallAction', ({ muted, callUUID }) => calls.get(callUUID)?.mute(muted));
  RNCallKeep.addEventListener('didToggleHoldCallAction', ({ hold, callUUID }) => calls.get(callUUID)?.hold(hold));
  RNCallKeep.addEventListener('didPerformDTMFAction', ({ digits, callUUID }) => calls.get(callUUID)?.sendDigits(digits));
  // Siri / CarPlay / recents → "Call Olivia with CloudConnect"
  RNCallKeep.addEventListener('didReceiveStartCallAction', ({ handle }) => { if (handle) startCall(handle).catch(() => undefined); });
}

export async function startCall(to: string) {
  const { token } = await api('/v1/telephony/token');
  const call = await voice.connect(token, { params: { To: to } });
  const uuid = call.getSid() ?? `${Date.now()}`;
  calls.set(uuid, call);
  RNCallKeep.startCall(uuid, to, to, 'number', false);
  call.on(Call.Event.Connected, () => Platform.OS === 'ios' ? RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid) : RNCallKeep.setCurrentCallActive(uuid));
  call.on(Call.Event.Disconnected, () => { RNCallKeep.endCall(uuid); calls.delete(uuid); });
  return uuid;
}
