/**
 * Call routing engine. A RoutingFlow is a directed graph of nodes attached to a phone number.
 * The engine is pure: given the flow, the current node and call inputs, it returns the next
 * telephony action. Provider adapters (TwiML/TeXML/etc.) render actions to provider markup.
 */
import { BusinessSchedule, evaluateSchedule } from './schedule';

export type RingStrategy = 'simultaneous' | 'sequential' | 'round_robin' | 'longest_idle';

export interface RingTarget { extension: string; userId?: string; destination: string /* sip:/client:/E.164 */; available?: boolean; lastCallEndedAt?: number }

export type FlowNode =
  | { id: string; type: 'schedule'; schedule: BusinessSchedule; open: string; closed: string; holiday?: string }
  | { id: string; type: 'menu'; prompt: string; language?: string; options: Record<string, string>; timeoutSeconds?: number; maxRetries?: number; onTimeout?: string; onInvalid?: string }
  | { id: string; type: 'ring_group'; name: string; strategy: RingStrategy; targets: RingTarget[]; ringTimeoutSeconds: number; onNoAnswer: string; callerIdPassthrough?: boolean }
  | { id: string; type: 'forward'; to: string; timeoutSeconds?: number; onNoAnswer?: string }
  | { id: string; type: 'voicemail'; mailboxId: string; greeting?: string; transcribe?: boolean }
  | { id: string; type: 'say'; text: string; language?: string; next: string }
  | { id: string; type: 'queue'; queueId: string; holdMusicUrl?: string; maxWaitSeconds?: number; onTimeout: string }
  | { id: string; type: 'ai_receptionist'; agentId: string; fallback: string }
  | { id: string; type: 'language_select'; options: Record<string, { language: string; next: string }>; prompt: string; onTimeout: string }
  | { id: string; type: 'hangup' };

export interface RoutingFlow {
  id: string;
  name: string;
  entry: string;
  nodes: Record<string, FlowNode>;
  recordCalls?: boolean;
  blockAnonymous?: boolean;
  spamScoreThreshold?: number; // 0..1, calls with score >= threshold are rejected
}

export interface CallContext {
  from: string;            // E.164 or "anonymous"
  to: string;
  now?: Date;
  digits?: string;         // DTMF from a <Gather>
  attempt?: number;        // retry counter for menus/sequential rings
  language?: string;
  spamScore?: number;      // from spam detection service
  blocked?: boolean;       // caller is on org blocklist
  roundRobinCursor?: number;
}

export type RoutingAction =
  | { kind: 'reject'; reason: 'blocked' | 'anonymous' | 'spam' }
  | { kind: 'say'; text: string; language: string; then: Continuation }
  | { kind: 'gather'; prompt: string; language: string; timeoutSeconds: number; numDigits: number; nodeId: string; attempt: number; then: Continuation }
  | { kind: 'dial'; targets: string[]; timeoutSeconds: number; nodeId: string; record: boolean; callerIdPassthrough: boolean; then: Continuation; sequenceIndex?: number }
  | { kind: 'voicemail'; mailboxId: string; greeting: string; language: string; transcribe: boolean }
  | { kind: 'enqueue'; queueId: string; holdMusicUrl?: string; maxWaitSeconds: number; then: Continuation }
  | { kind: 'ai_agent'; agentId: string; then: Continuation }
  | { kind: 'hangup' };

/** Where the provider should call back to continue the flow. */
export interface Continuation { nodeId: string; attempt?: number; sequenceIndex?: number; language?: string }

export class RoutingError extends Error {}

const MAX_HOPS = 25;
/** Sentinel continuation meaning "end the call". */
export const HANGUP_NODE = '__hangup';

export function validateFlow(flow: RoutingFlow): string[] {
  const errors: string[] = [];
  if (!flow.nodes[flow.entry]) errors.push(`entry node "${flow.entry}" does not exist`);
  const refs = (n: FlowNode): string[] => {
    switch (n.type) {
      case 'schedule': return [n.open, n.closed, ...(n.holiday ? [n.holiday] : [])];
      case 'menu': return [...Object.values(n.options), ...(n.onTimeout ? [n.onTimeout] : []), ...(n.onInvalid ? [n.onInvalid] : [])];
      case 'ring_group': return [n.onNoAnswer];
      case 'forward': return n.onNoAnswer ? [n.onNoAnswer] : [];
      case 'say': return [n.next];
      case 'queue': return [n.onTimeout];
      case 'ai_receptionist': return [n.fallback];
      case 'language_select': return [...Object.values(n.options).map((o) => o.next), n.onTimeout];
      default: return [];
    }
  };
  for (const [key, node] of Object.entries(flow.nodes)) {
    if (node.id !== key) errors.push(`node key "${key}" does not match id "${node.id}"`);
    for (const r of refs(node)) if (!flow.nodes[r]) errors.push(`node "${key}" references missing node "${r}"`);
    if (node.type === 'menu') for (const d of Object.keys(node.options)) if (!/^[0-9*#]$/.test(d)) errors.push(`node "${key}" has invalid digit "${d}"`);
    if (node.type === 'ring_group' && node.targets.length === 0) errors.push(`ring group "${key}" has no targets`);
  }
  return errors;
}

/** Pre-flight screening applied on the first webhook for an inbound call. */
export function screenCall(flow: RoutingFlow, ctx: CallContext): RoutingAction | null {
  if (ctx.blocked) return { kind: 'reject', reason: 'blocked' };
  const anon = !ctx.from || /^(anonymous|restricted|unknown|private)$/i.test(ctx.from);
  if (flow.blockAnonymous && anon) return { kind: 'reject', reason: 'anonymous' };
  if (flow.spamScoreThreshold !== undefined && (ctx.spamScore ?? 0) >= flow.spamScoreThreshold) return { kind: 'reject', reason: 'spam' };
  return null;
}

export function orderTargets(strategy: RingStrategy, targets: RingTarget[], cursor = 0): RingTarget[] {
  const available = targets.filter((t) => t.available !== false);
  switch (strategy) {
    case 'round_robin': {
      if (!available.length) return [];
      const start = cursor % available.length;
      return [...available.slice(start), ...available.slice(0, start)];
    }
    case 'longest_idle':
      return [...available].sort((a, b) => (a.lastCallEndedAt ?? 0) - (b.lastCallEndedAt ?? 0));
    default:
      return available;
  }
}

/**
 * Resolve the action for `nodeId`. Non-blocking nodes (schedule, menu input) are followed
 * until a node that needs the telephony provider is reached.
 */
export function step(flow: RoutingFlow, nodeId: string | undefined, ctx: CallContext): RoutingAction {
  let current = nodeId ?? flow.entry;
  let digits = ctx.digits;
  let attempt = ctx.attempt ?? 0;
  let language = ctx.language ?? 'en-US';
  const now = ctx.now ?? new Date();

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (current === HANGUP_NODE) return { kind: 'hangup' };
    const node = flow.nodes[current];
    if (!node) throw new RoutingError(`Unknown node "${current}"`);

    switch (node.type) {
      case 'schedule': {
        const state = evaluateSchedule(node.schedule, now);
        current = state === 'open' ? node.open : state === 'holiday' ? (node.holiday ?? node.closed) : node.closed;
        continue;
      }
      case 'language_select': {
        if (digits === undefined) {
          return { kind: 'gather', prompt: node.prompt, language, timeoutSeconds: 5, numDigits: 1, nodeId: node.id, attempt, then: { nodeId: node.id, attempt, language } };
        }
        const opt = node.options[digits];
        digits = undefined;
        if (!opt) { current = node.onTimeout; continue; }
        language = opt.language;
        current = opt.next;
        attempt = 0;
        continue;
      }
      case 'menu': {
        const lang = node.language ?? language;
        const maxRetries = node.maxRetries ?? 2;
        if (digits === undefined) {
          return { kind: 'gather', prompt: node.prompt, language: lang, timeoutSeconds: node.timeoutSeconds ?? 5, numDigits: 1, nodeId: node.id, attempt, then: { nodeId: node.id, attempt, language } };
        }
        const target = digits === '' ? undefined : node.options[digits];
        if (target) { digits = undefined; attempt = 0; current = target; continue; }
        // no input or invalid input: re-prompt up to maxRetries, then fall back
        const noInput = digits === '';
        const fallback = noInput ? node.onTimeout : node.onInvalid;
        digits = undefined;
        if (attempt < maxRetries) {
          const text = noInput ? "Sorry, I didn't hear a selection." : "Sorry, that's not a valid option.";
          return { kind: 'say', text, language: lang, then: { nodeId: node.id, attempt: attempt + 1, language } };
        }
        if (fallback) { attempt = 0; current = fallback; continue; }
        return { kind: 'hangup' };
      }
      case 'say':
        return { kind: 'say', text: node.text, language: node.language ?? language, then: { nodeId: node.next, language } };
      case 'ring_group': {
        const ordered = orderTargets(node.strategy, node.targets, ctx.roundRobinCursor);
        if (!ordered.length) { current = node.onNoAnswer; continue; }
        const record = !!flow.recordCalls;
        const passthrough = node.callerIdPassthrough ?? true;
        if (node.strategy === 'simultaneous') {
          return { kind: 'dial', targets: ordered.map((t) => t.destination), timeoutSeconds: node.ringTimeoutSeconds, nodeId: node.id, record, callerIdPassthrough: passthrough, then: { nodeId: node.onNoAnswer, language } };
        }
        // sequential / round robin / longest idle: ring one at a time (hunt group)
        const idx = attempt;
        if (idx >= ordered.length) { current = node.onNoAnswer; continue; }
        const nextIsLast = idx + 1 >= ordered.length;
        return {
          kind: 'dial', targets: [ordered[idx].destination], timeoutSeconds: node.ringTimeoutSeconds, nodeId: node.id, record,
          callerIdPassthrough: passthrough, sequenceIndex: idx,
          then: nextIsLast ? { nodeId: node.onNoAnswer, language } : { nodeId: node.id, attempt: idx + 1, sequenceIndex: idx + 1, language },
        };
      }
      case 'forward':
        return { kind: 'dial', targets: [node.to], timeoutSeconds: node.timeoutSeconds ?? 30, nodeId: node.id, record: !!flow.recordCalls, callerIdPassthrough: true, then: { nodeId: node.onNoAnswer ?? HANGUP_NODE, language } };
      case 'voicemail':
        return { kind: 'voicemail', mailboxId: node.mailboxId, greeting: node.greeting ?? 'Please leave a message after the tone.', language, transcribe: node.transcribe ?? true };
      case 'queue':
        return { kind: 'enqueue', queueId: node.queueId, holdMusicUrl: node.holdMusicUrl, maxWaitSeconds: node.maxWaitSeconds ?? 600, then: { nodeId: node.onTimeout, language } };
      case 'ai_receptionist':
        return { kind: 'ai_agent', agentId: node.agentId, then: { nodeId: node.fallback, language } };
      case 'hangup':
        return { kind: 'hangup' };
    }
  }
  throw new RoutingError('Routing loop detected (too many hops)');
}
