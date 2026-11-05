import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { config } from '../../config';
import { Analysis, analyzeTranscript } from './analyzer';

export interface ReceptionistTurn {
  reply: string;
  intent: 'answer' | 'transfer' | 'book_appointment' | 'take_message' | 'end';
  department?: string;
  appointment?: { startIso: string; name?: string; reason?: string };
  message?: string;
}

/** Thin wrapper around OpenAI GPT with deterministic fallbacks so every feature works offline. */
@Injectable()
export class AiService {
  private log = new Logger('AI');
  private client = config().OPENAI_API_KEY ? new OpenAI({ apiKey: config().OPENAI_API_KEY }) : null;
  get enabled() { return !!this.client; }

  private async json<T>(system: string, user: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const r = await this.client.chat.completions.create({
        model: config().OPENAI_MODEL, temperature: 0.2, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return JSON.parse(r.choices[0].message.content ?? 'null');
    } catch (e) {
      this.log.warn(`OpenAI call failed, using fallback: ${(e as Error).message}`);
      return null;
    }
  }

  /** Summary, sentiment, action items, keywords, call score and sales coaching for a call or meeting. */
  async analyze(transcript: string, kind: 'call' | 'meeting' | 'voicemail' = 'call'): Promise<Analysis & { model: string }> {
    const llm = await this.json<Analysis>(
      `You analyze business ${kind} transcripts. Respond with JSON: {"summary": string (<=3 sentences), "sentiment": "positive"|"neutral"|"negative"|"mixed", "sentimentScore": number -1..1, "actionItems": [{"text": string, "owner"?: string, "due"?: string}], "keywords": string[] (<=8), "callScore": integer 0-100 (professionalism, discovery, resolution), "coaching": string[] (<=4 concrete sales/support coaching tips)}. Never invent facts not in the transcript.`,
      transcript.slice(0, 48_000),
    );
    if (llm && typeof llm.summary === 'string') return { ...analyzeTranscript(transcript), ...llm, model: config().OPENAI_MODEL };
    return { ...analyzeTranscript(transcript), model: 'heuristic-v1' };
  }

  /** Speech-to-text for recordings (Whisper). Returns null when AI is not configured. */
  async transcribeUrl(audioUrl: string, auth?: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = await fetch(audioUrl, { headers: auth ? { Authorization: auth } : {} });
      if (!res.ok) return null;
      const file = await OpenAI.toFile(Buffer.from(await res.arrayBuffer()), 'audio.mp3');
      const r = await this.client.audio.transcriptions.create({ file, model: 'whisper-1' });
      return r.text;
    } catch (e) {
      this.log.warn(`transcription failed: ${(e as Error).message}`);
      return null;
    }
  }

  async summarizeVoicemail(transcript: string): Promise<string> {
    const r = await this.json<{ summary: string }>('Summarize this voicemail in one sentence including caller intent and any callback number. JSON: {"summary": string}', transcript);
    return r?.summary ?? analyzeTranscript(transcript).summary;
  }

  /** AI-assisted reply drafting for SMS / chat. */
  async draftReplies(history: { direction: string; body: string }[], tone = 'friendly, professional'): Promise<string[]> {
    const r = await this.json<{ replies: string[] }>(
      `Draft 3 short SMS replies (<=300 chars) for a business agent. Tone: ${tone}. JSON: {"replies": string[]}`,
      history.slice(-20).map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Agent'}: ${m.body}`).join('\n'),
    );
    if (r?.replies?.length) return r.replies.slice(0, 3);
    const last = [...history].reverse().find((m) => m.direction === 'inbound')?.body ?? '';
    return [
      'Thanks for reaching out! Let me look into that and get right back to you.',
      /\?/.test(last) ? 'Great question — can I give you a quick call to go over the details?' : 'Got it, thank you. Is there anything else I can help with?',
      'Thanks! What time works best for a quick follow-up?',
    ];
  }

  async translate(text: string, targetLanguage: string): Promise<{ text: string; detectedLanguage?: string; translated: boolean }> {
    const r = await this.json<{ text: string; detectedLanguage: string }>(
      `Translate the user's text to ${targetLanguage}. Preserve meaning, names and numbers. JSON: {"text": string, "detectedLanguage": BCP-47 string}`, text);
    return r ? { ...r, translated: true } : { text, translated: false };
  }

  /** One turn of the AI receptionist (phone answering, routing, appointment booking, message taking). */
  async receptionist(p: { company: string; instructions?: string; departments: string[]; history: { role: 'caller' | 'agent'; text: string }[]; nowIso: string; timezone: string }): Promise<ReceptionistTurn> {
    const r = await this.json<ReceptionistTurn>(
      `You are the friendly AI receptionist for ${p.company}. ${p.instructions ?? ''}
Current time: ${p.nowIso} (${p.timezone}). Departments you may transfer to: ${p.departments.join(', ') || 'none'}.
Keep replies under 40 words, suitable for text-to-speech. Respond in the caller's language.
JSON: {"reply": string, "intent": "answer"|"transfer"|"book_appointment"|"take_message"|"end", "department"?: string, "appointment"?: {"startIso": string, "name"?: string, "reason"?: string}, "message"?: string}`,
      p.history.map((h) => `${h.role}: ${h.text}`).join('\n') || 'caller: (call connected)',
    );
    if (r?.reply) return r;
    // Rule-based fallback
    const last = p.history.filter((h) => h.role === 'caller').pop()?.text.toLowerCase() ?? '';
    if (!last) return { reply: `Thanks for calling ${p.company}. How can I help you today?`, intent: 'answer' };
    const dept = p.departments.find((d) => last.includes(d.toLowerCase()));
    if (dept) return { reply: `Sure, connecting you to ${dept} now.`, intent: 'transfer', department: dept };
    if (/appointment|book|schedule|meeting/.test(last)) return { reply: 'I can help with that. I\'ll have someone confirm a time with you shortly.', intent: 'take_message', message: last };
    if (/bye|that's all|thank you/.test(last)) return { reply: 'Thanks for calling. Goodbye!', intent: 'end' };
    return { reply: 'I\'ll take a message so the right person can call you back. Please go ahead.', intent: 'take_message', message: last };
  }
}
