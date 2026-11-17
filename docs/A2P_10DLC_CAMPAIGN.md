# A2P 10DLC campaign — draft for Twilio registration

Paste into Twilio Console → Messaging → Regulatory Compliance → Onboarding → *Register a campaign*.
Replace every **[bracketed]** value with real, verifiable details. Reviewers reject campaigns whose
description, samples or opt-in don't match what the business actually does — keep it truthful.

**Messaging Service:** `CloudConnect AI` (contains +1 845-447-9837, +1 845-447-0830, +1 845-377-4353;
numbers purchased in CloudConnect are added automatically).

**Use case:** `Mixed` (covers customer care, appointment reminders and account notifications).
If you will only ever reply to customers, `Customer Care` is simpler and approves faster.

## Campaign description
> [Business Name] uses its business phone numbers to text customers who contact us or who have given
> us their mobile number. Messages include replies to customer questions and support requests,
> appointment confirmations and reminders, callback and missed-call follow-ups, voicemail notices, and
> service/account updates. Messages are sent one-to-one by our staff and by our automated phone
> assistant on behalf of [Business Name]. We do not send marketing blasts, do not share or sell phone
> numbers, and every message identifies [Business Name] and supports STOP to opt out.

## Sample messages (5)
1. `[Business Name]: Thanks for calling! Sorry we missed you — how can we help? Reply here or call us back at (845) 447-9837. Reply STOP to opt out.`
2. `[Business Name]: Reminder — your appointment is on [Tue, Nov 25] at [10:30 AM]. Reply C to confirm or R to reschedule. Reply STOP to opt out.`
3. `[Business Name]: Hi [first name], following up on your support request #[1042]. It's resolved — reply here if you have any questions. Msg&data rates may apply.`
4. `[Business Name]: You have a new voicemail from (845) 555-0142. Call back or reply to this message. Reply HELP for help, STOP to opt out.`
5. `[Business Name]: Your service request was received. A team member will contact you within [1 business day]. Reply STOP to unsubscribe.`

## How customers opt in (Message flow / Call to action)
> Customers opt in in one of these ways: (1) they text our business number first — replying to their
> message is the conversation they started; (2) they call our business line and ask us to follow up by
> text, which our staff or phone assistant confirms verbally ("Can we text you at this number?") before
> sending; (3) they enter their mobile number in the contact / booking form at **[https://your-website/contact]**,
> which shows the disclosure: "By providing your mobile number you agree to receive texts from
> [Business Name] about your inquiry and appointments. Msg & data rates may apply. Msg frequency varies.
> Reply STOP to opt out, HELP for help. See our Privacy Policy [link] and Terms [link]."
> Consent is not a condition of purchase. Numbers are never shared with third parties for marketing.

Tip: TCR reviewers check that the website/form URL exists and shows that disclosure. If you don't have
a form yet, remove option (3) and keep (1) and (2), or add the disclosure to your site before submitting.

## Keywords and auto-replies (CloudConnect already handles these)
| Field | Value |
|---|---|
| Opt-in keywords | `START, YES, UNSTOP` |
| Opt-in confirmation | `[Business Name]: You're subscribed to messages about your requests and appointments. Msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to opt out.` |
| Opt-out keywords | `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT` |
| Opt-out message | `You have been unsubscribed from [Business Name]. Reply START to resubscribe.` |
| Help keywords | `HELP, INFO` |
| Help message | `[Business Name]: For help call (845) 447-9837 or email [support@your-domain]. Reply STOP to opt out. Msg&data rates may apply.` |

## Checkboxes
- Embedded links: **No** (tick Yes only if you'll include URLs; never use public link shorteners like bit.ly)
- Embedded phone numbers: **Yes** (samples include callback numbers)
- Age-gated content / Direct lending: **No**

## Brand (business) details you'll need
Legal business name (exactly as on IRS records), EIN, business type, industry, address, website,
authorized representative (name, title, email, phone). Sole Proprietor brands (no EIN) are limited to one
number, so they cannot cover all three numbers in the Messaging Service — use a Standard brand.
