/**
 * Deterministic conversation analyzer used when no LLM is configured (and as a cheap
 * pre-pass). Produces the same shape as the LLM analyzer.
 */
export interface Analysis {
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  sentimentScore: number; // -1..1
  actionItems: { text: string; owner?: string; due?: string }[];
  keywords: string[];
  callScore: number; // 0..100
  coaching: string[];
}

const POS = ['great', 'thanks', 'thank', 'perfect', 'happy', 'excellent', 'love', 'awesome', 'appreciate', 'helpful', 'resolved', 'good', 'wonderful', 'glad'];
const NEG = ['angry', 'frustrated', 'terrible', 'cancel', 'refund', 'broken', 'bad', 'worst', 'unhappy', 'disappointed', 'problem', 'issue', 'complaint', 'never', 'late', 'wrong'];
const STOP = new Set('the a an and or but if then so to of in on at for with is are was were be been it this that i you we they he she me my your our us them do does did have has had not no yes can will would could should just about from as by what when where how who which there their its im dont thats going get got okay ok um uh like yeah well know think want need let'.split(' '));
const ACTION = /\b(i will|i'll|we will|we'll|let me|i'm going to|we're going to|please|can you|could you|follow up|send (you|over)|schedule|by (monday|tuesday|wednesday|thursday|friday|tomorrow|next week|end of day|eod))\b/i;

export function analyzeTranscript(text: string): Analysis {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  let pos = 0, neg = 0;
  for (const w of words) { if (POS.includes(w)) pos++; else if (NEG.includes(w)) neg++; }
  const total = pos + neg;
  const score = total ? (pos - neg) / total : 0;
  const sentiment = total === 0 ? 'neutral' : pos && neg && Math.abs(score) < 0.3 ? 'mixed' : score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral';

  const freq = new Map<string, number>();
  for (const w of words) if (w.length > 3 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([w]) => w);

  const actionItems = sentences.filter((s) => ACTION.test(s)).slice(0, 10).map((s) => ({ text: s.replace(/^\w+:\s*/, '') }));
  const summary = sentences.length <= 2 ? sentences.join(' ') : `${sentences[0]} … ${sentences[sentences.length - 1]}`.slice(0, 400);

  const questions = (text.match(/\?/g) ?? []).length;
  const coaching: string[] = [];
  if (questions < 2) coaching.push('Ask more open-ended discovery questions.');
  if (!/\b(name|thank you|thanks)\b/i.test(text)) coaching.push('Use the customer\'s name and thank them for their time.');
  if (!actionItems.length) coaching.push('Close with clear next steps and owners.');
  if (sentiment === 'negative') coaching.push('Acknowledge frustration explicitly before proposing a fix.');
  const callScore = Math.max(0, Math.min(100, Math.round(60 + score * 25 + Math.min(questions, 5) * 3 + Math.min(actionItems.length, 3) * 4 - coaching.length * 3)));
  return { summary, sentiment, sentimentScore: Number(score.toFixed(3)), actionItems, keywords, callScore, coaching };
}
