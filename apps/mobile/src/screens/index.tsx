import { Audio } from 'expo-av';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, saveSession } from '../lib/api';
import { startCall } from '../lib/calling';

const brand = '#2550eb';
function useList<T>(path: string) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { const r = await api(path); setData(Array.isArray(r) ? r : r.data); } catch { /* offline cache miss */ } finally { setLoading(false); } }, [path]);
  useEffect(() => { load(); }, [load]);
  return { data, loading, load };
}
const fmt = (e: string) => e?.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') ?? '';

export function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [mfa, setMfa] = useState(''); const [needMfa, setNeedMfa] = useState(false);
  const submit = async () => {
    try {
      const r = await api('/v1/auth/login', { body: { email, password, ...(needMfa ? { mfaCode: mfa } : {}) } });
      if (r.mfaRequired) return setNeedMfa(true);
      await saveSession(r); onLogin();
    } catch (e) { Alert.alert('Sign in failed', (e as Error).message); }
  };
  return (
    <View style={s.center}>
      <Text style={s.h1}>CloudConnect AI</Text>
      <TextInput style={s.input} placeholder="Work email" autoCapitalize="none" keyboardType="email-address" textContentType="username" value={email} onChangeText={setEmail} />
      <TextInput style={s.input} placeholder="Password" secureTextEntry textContentType="password" value={password} onChangeText={setPassword} />
      {needMfa && <TextInput style={s.input} placeholder="6-digit code" keyboardType="number-pad" textContentType="oneTimeCode" value={mfa} onChangeText={setMfa} />}
      <Pressable style={s.button} onPress={submit}><Text style={s.buttonText}>Sign in</Text></Pressable>
    </View>
  );
}

export function CallsScreen() {
  const { data, loading, load } = useList<any>('/v1/calls?limit=50');
  return <FlatList data={data} keyExtractor={(c) => c.id} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />} renderItem={({ item: c }) => {
    const other = c.direction === 'inbound' ? c.from : c.to;
    const missed = c.direction === 'inbound' && !c.answeredAt;
    return (
      <Pressable style={s.row} onPress={() => startCall(other)}>
        <Text style={[s.title, missed && { color: '#e11d48' }]}>{fmt(other)}</Text>
        <Text style={s.sub}>{c.direction} · {new Date(c.startedAt).toLocaleString()} {c.sentiment ? `· AI: ${c.sentiment}` : ''}</Text>
      </Pressable>);
  }} />;
}

export function MessagesScreen() {
  const { data, loading, load } = useList<any>('/v1/conversations');
  const [open, setOpen] = useState<any>(null);
  const [body, setBody] = useState('');
  if (open) return (
    <View style={{ flex: 1 }}>
      <Pressable onPress={() => setOpen(null)} style={s.row}><Text style={{ color: brand }}>‹ Back</Text></Pressable>
      <Thread id={open.id} />
      <View style={{ flexDirection: 'row', padding: 8, gap: 8 }}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} value={body} onChangeText={setBody} placeholder="Message" />
        <Pressable style={[s.button, { marginTop: 0 }]} onPress={async () => {
          await api(open.kind.includes('chat') ? `/v1/chats/${open.id}/messages` : '/v1/messages', { body: open.kind.includes('chat') ? { body } : { to: open.participants, from: open.number, body }, offlineQueue: true });
          setBody('');
        }}><Text style={s.buttonText}>Send</Text></Pressable>
      </View>
    </View>);
  return <FlatList data={data} keyExtractor={(c) => c.id} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />} renderItem={({ item }) => (
    <Pressable style={s.row} onPress={() => setOpen(item)}><Text style={s.title}>{item.contactName ?? item.title ?? fmt(item.participants[0])}{item.unread ? ` (${item.unread})` : ''}</Text><Text style={s.sub} numberOfLines={1}>{item.lastMessage}</Text></Pressable>)} />;
}
function Thread({ id }: { id: string }) {
  const { data } = useList<any>(`/v1/conversations/${id}/messages`);
  return <FlatList style={{ flex: 1 }} data={data} keyExtractor={(m) => m.id} renderItem={({ item: m }) => (
    <View style={[s.bubble, m.direction === 'outbound' ? { alignSelf: 'flex-end', backgroundColor: brand } : { alignSelf: 'flex-start', backgroundColor: '#e2e8f0' }]}><Text style={{ color: m.direction === 'outbound' ? '#fff' : '#0f172a' }}>{m.body}</Text></View>)} />;
}

export function KeypadScreen({ route }: any) {
  const [n, setN] = useState(route?.params?.number ?? '');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  return (
    <View style={s.center}>
      <Text style={[s.h1, { minHeight: 40 }]}>{n}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 270 }}>{keys.map((k) => <Pressable key={k} style={s.key} onPress={() => setN(n + k)}><Text style={{ fontSize: 28 }}>{k}</Text></Pressable>)}</View>
      <Pressable style={[s.button, { backgroundColor: '#059669', width: 200 }]} onPress={() => n && startCall(n)}><Text style={s.buttonText}>Call</Text></Pressable>
      <Pressable onPress={() => setN(n.slice(0, -1))}><Text style={{ marginTop: 12, color: '#64748b' }}>Delete</Text></Pressable>
    </View>
  );
}

export function VoicemailScreen() {
  const { data, loading, load } = useList<any>('/v1/voicemails');
  const play = async (v: any) => {
    const { url } = await api(`/v1/voicemails/${v.id}/audio`);
    await api(`/v1/voicemails/${v.id}`, { method: 'PATCH', body: { isRead: true } });
    const { sound } = await Audio.Sound.createAsync({ uri: url }); await sound.playAsync();
  };
  return <FlatList data={data} keyExtractor={(v) => v.id} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />} renderItem={({ item: v }) => (
    <Pressable style={s.row} onPress={() => play(v)} onLongPress={() => startCall(v.from)}>
      <Text style={[s.title, !v.isRead && { fontWeight: '700' }]}>{v.contactName ?? fmt(v.from)} · {v.durationSeconds}s</Text>
      {v.aiSummary && <Text style={s.sub}>✨ {v.aiSummary}</Text>}
    </Pressable>)} />;
}

export function ContactsScreen() {
  const [q, setQ] = useState('');
  const { data } = useList<any>(`/v1/contacts?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  return (
    <View style={{ flex: 1 }}>
      <TextInput style={[s.input, { margin: 12 }]} placeholder="Search" value={q} onChangeText={setQ} />
      <FlatList data={data} keyExtractor={(c) => c.id} renderItem={({ item: c }) => (
        <Pressable style={s.row} onPress={() => c.phones[0] && startCall(c.phones[0])}><Text style={s.title}>{c.favorite ? '★ ' : ''}{c.firstName} {c.lastName}</Text><Text style={s.sub}>{c.company ?? ''} {fmt(c.phones[0])}</Text></Pressable>)} />
    </View>
  );
}

export function MeetingsScreen() {
  const { data, loading, load } = useList<any>('/v1/meetings?upcoming=true');
  return <FlatList data={data} keyExtractor={(m) => m.id} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />} renderItem={({ item: m }) => (
    <Pressable style={s.row} onPress={() => Linking.openURL(`https://app.cloudconnect.ai/meet/${m.joinCode}`)}><Text style={s.title}>{m.title}</Text><Text style={s.sub}>{m.scheduledStart ? new Date(m.scheduledStart).toLocaleString() : 'Now'}</Text></Pressable>)} />;
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  h1: { fontSize: 26, fontWeight: '600', marginBottom: 24 },
  input: { width: '100%', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 16 },
  button: { backgroundColor: brand, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20, alignItems: 'center', marginTop: 8, width: '100%' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e2e8f0' },
  title: { fontSize: 16, fontWeight: '500' }, sub: { fontSize: 13, color: '#64748b', marginTop: 2 },
  key: { width: 90, height: 72, alignItems: 'center', justifyContent: 'center' },
  bubble: { margin: 6, padding: 10, borderRadius: 14, maxWidth: '78%' },
});
