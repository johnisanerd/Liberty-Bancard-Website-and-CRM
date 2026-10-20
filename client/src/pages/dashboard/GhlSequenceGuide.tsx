import { GhlOwnershipNotice } from "@/components/dashboard/GhlOwnershipNotice";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  Mail, MessageSquare, Phone, Mic, ClipboardList, Bot, Copy, CheckCircle2,
  Tag, ArrowRight, AlertCircle, Zap, ExternalLink, ChevronDown, ChevronRight,
  ListChecks, Calendar, Users, Settings, Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Step {
  num: number;
  channel: "email" | "sms" | "call" | "voicemail" | "task" | "ai";
  delay: string;
  subject?: string;
  copy: string;
  ghlNote?: string;
  branch?: string;
}

interface Workflow {
  id: string;
  name: string;
  goal: string;
  trigger: string;
  triggerTag: string;
  color: string;
  steps: Step[];
  exitConditions: string[];
  checklist: string[];
}

// ─── Channel config ────────────────────────────────────────────────────────────

const CHANNEL_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; color: string }> = {
  email:     { icon: Mail,          label: "Email",        color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  sms:       { icon: MessageSquare, label: "SMS",          color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  call:      { icon: Phone,         label: "AI Voice Call",color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
  voicemail: { icon: Mic,           label: "Voicemail Drop",color: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  task:      { icon: ClipboardList, label: "Internal Task", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  ai:        { icon: Bot,           label: "AI Conversation", color: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300" },
};

// ─── Workflow data ─────────────────────────────────────────────────────────────

const WORKFLOWS: Workflow[] = [
  {
    id: "inbound",
    name: "Workflow 1 — Speed-to-Lead (Inbound)",
    goal: "Reach the merchant within 60 seconds. Speed-to-lead is the #1 conversion lever for inbound leads.",
    trigger: "Contact submits any web form, chat widget, or GHL landing page. Fire immediately.",
    triggerTag: "LB-INBOUND-NEW",
    color: "border-blue-500",
    steps: [
      {
        num: 1, channel: "email", delay: "Immediately (< 2 min)",
        subject: "Got your request — here's what happens next, {{contact.firstName}}",
        copy: `Hi {{contact.firstName}},

We got your message and someone from our team will reach out within the hour.

Quick shortcut: if you have a recent merchant processing statement, reply and attach it now. We'll run a full cost comparison before we even talk — so instead of starting from scratch on the call, you come in knowing exactly what you're overpaying.

Takes us 24 hours. Costs you nothing.

— Scott Allen, Liberty Bancard
📞 (888) 555-0100 | www.libertybancard.com

Eligibility, underwriting, and card brand rules apply.`,
        ghlNote: "GHL Action: Send Email → use Liberty Bancard branded template. Add reply-tracking.",
      },
      {
        num: 2, channel: "sms", delay: "2 minutes after form submit",
        copy: `Hi {{contact.firstName}} — Liberty Bancard here. Got your request. Someone's calling you shortly. If you have a merchant statement handy, reply with it and we'll have your savings analysis ready before the call. Reply STOP to opt out.`,
        ghlNote: "GHL Action: Send SMS. Enable two-way SMS. Trigger Reply Engaged workflow on any inbound reply.",
      },
      {
        num: 3, channel: "task", delay: "5 minutes after form submit",
        copy: `⚡ PRIORITY LEAD — Call NOW\n{{contact.firstName}} {{contact.lastName}} just submitted a form.\nPhone: {{contact.phone}} | Business: {{contact.companyName}}\nGoal: Book statement review call or get statement on the call.\nCheck inbox — they may have already replied with a statement.`,
        ghlNote: "GHL Action: Create Task → assign to assigned user or round-robin SDR group.",
      },
      {
        num: 4, channel: "call", delay: "15 minutes (GHL Voice AI — intro_qualification mode)",
        copy: `"Hi, is this {{contact.firstName}}? [pause] Great — this is the Liberty Bancard AI calling to follow up on the request you just submitted. I can answer questions and help you get started right now, or connect you with one of our account managers.\n\nDo you have a merchant processing statement we could review for you? [If yes] → Excellent. I can connect you with our analysis team right now, or you can email it to analysis@libertybancard.com and we'll have a full breakdown back to you within 24 hours.\n\n[If no/not sure] → No problem. Our account managers can walk you through exactly what to pull up. Can I book a 15-minute call for you?"`,
        branch: "Answered → qualification flow | Voicemail → Step 5 voicemail drop | No Answer → wait 2 hr → retry call",
        ghlNote: "GHL Action: AI Voice Call → Voice AI Employee (intro_qualification). Set to business hours 9 AM–5 PM local time. Connect GHL calendar for live booking.",
      },
      {
        num: 5, channel: "voicemail", delay: "If no answer on Step 4 (pre-recorded drop)",
        copy: `"Hi {{contact.firstName}}, this is Scott with Liberty Bancard calling about the request you just submitted. Give me a call back at 888-555-0100 or reply to the text we just sent you — I'll be watching for it. Talk soon."`,
        ghlNote: "GHL Action: Voicemail Drop → select pre-recorded audio from Media Library. Record separately and upload before activating workflow.",
      },
      {
        num: 6, channel: "call", delay: "2 hours later — retry if still no contact",
        copy: `[Same Voice AI script as Step 4 — intro_qualification mode]`,
        branch: "Answered → stop sequence, tag LB-CALLED | Voicemail → drop VM | No Answer → continue to Day 1 email",
        ghlNote: "GHL: Add If/Else branch after call — check contact.replied or tag LB-CALLED.",
      },
      {
        num: 7, channel: "email", delay: "Next morning, 9 AM local time",
        subject: "One thing most merchants don't know about their rates",
        copy: `Hi {{contact.firstName}},

Most merchants assume their processing rate is competitive. Most are wrong.

The way processor pricing works, the markup your processor charges sits on top of the base interchange rate set by Visa/Mastercard. That markup is 100% negotiable — but most merchants never push back because they don't know what number to push back to.

When we run a statement review, the first thing we do is strip out the interchange (the fixed part you can't change) and show you exactly what you're paying your processor in markup. That's the number that matters.

If you're willing to take 2 minutes to upload a statement, I'll tell you where you stand:

[Statement Upload Link]

— Scott Allen, Liberty Bancard`,
      },
      {
        num: 8, channel: "sms", delay: "Day 2, 10 AM",
        copy: `{{contact.firstName}} — quick follow-up from Liberty Bancard. Did you get a chance to pull a recent statement? Reply with a photo or PDF and we'll run your free analysis. Reply STOP to opt out.`,
      },
      {
        num: 9, channel: "ai", delay: "Day 3 — GHL AI SMS Conversation",
        copy: `"Hi {{contact.firstName}}, this is the Liberty Bancard AI assistant. Just checking in — do you have questions about our statement review process, or would you like to book a quick call with our team? I can answer questions or get a time on the calendar right now."`,
        ghlNote: "GHL Action: Assign conversation to AI Employee (Text channel). AI handles objections, books via GHL calendar link, or escalates to human SDR on trigger phrases.",
      },
    ],
    exitConditions: [
      "Any reply received → tag LB-SDR-REPLY-ENGAGED → enroll in Workflow 3",
      "Statement uploaded → tag LB-STATEMENT-RECEIVED → trigger statement review workflow",
      "Appointment booked → tag LB-BOOKING-READY → stop sequence",
      "STOP reply → tag LB-DNC → stop all sequences immediately",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-INBOUND-NEW",
      "Configure email template with Liberty Bancard branding",
      "Enable two-way SMS and set reply trigger → enroll in Workflow 3",
      "Create Voice AI Employee (Phone channel) with intro_qualification script",
      "Record and upload Voicemail Drop audio to GHL Media Library",
      "Create Task action → assign to SDR round-robin group",
      "Create AI Employee (Text/SMS channel) with conversation AI system prompt",
      "Connect GHL calendar to AI Employee for live appointment booking",
      "Add If/Else branches for each call disposition",
      "Set workflow timezone to contact's local timezone",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "cold",
    name: "Workflow 2 — Cold Outbound Prospecting",
    goal: "12-day multi-touch cadence to get a statement or book an intro call from a cold prospect.",
    trigger: "Prospect identified via SDR enrichment, Sunbiz import, or manual upload. Volume sequence.",
    triggerTag: "LB-COLD-OUTBOUND",
    color: "border-slate-500",
    steps: [
      {
        num: 1, channel: "email", delay: "Day 1 — 9 AM local time",
        subject: "Your processor is probably charging you too much",
        copy: `Hi {{contact.firstName}},

Quick question: when's the last time you actually looked at what you're paying in processing fees vs. what your processor is marking up?

Most merchants on legacy pricing are paying 0.30–0.80% more than they should. On $100,000/month in volume, that's $300–$800/month going straight to your processor as pure margin.

We do a free statement review that shows you exactly where your money is going — no obligation, no sales pressure. Just numbers.

Worth 2 minutes of your time? Reply "yes" and I'll send you the upload link.

— Scott Allen, Liberty Bancard
Eligibility, underwriting, and card brand rules apply.`,
        ghlNote: "GHL: Send Email. Use merge fields. Enable reply detection → trigger Workflow 3 (Reply Engaged).",
      },
      {
        num: 2, channel: "sms", delay: "Day 2 — 10 AM",
        copy: `Hi {{contact.firstName}}, Scott with Liberty Bancard. Most merchants never look at their processing markup — it's usually buried in the statement. Want me to pull it out and show you what you're actually paying? Reply YES and I'll send instructions. Reply STOP to opt out.`,
      },
      {
        num: 3, channel: "task", delay: "Day 3 — internal",
        copy: `Review contact profile for {{contact.firstName}} {{contact.lastName}} at {{contact.companyName}}.\nCheck LinkedIn/website for recent news or triggers.\nAdd personalization note to Day 5 email if possible.\nNo response yet — do not call today.`,
        ghlNote: "GHL: Create Task → assign to rep. Internal prep only, no outbound contact on Day 3.",
      },
      {
        num: 4, channel: "email", delay: "Day 5 — 9 AM",
        subject: "The one fee merchants never think about",
        copy: `Hi {{contact.firstName}},

There's a fee on your merchant statement called the "processor markup" or "non-qualified surcharge" — it goes by different names depending on your provider.

It's usually between 0.10% and 1.50% of your entire volume. On $50K/month that's $50–$750/month that has nothing to do with Visa or Mastercard. It's pure processor margin.

We reviewed a restaurant last month paying 1.2% markup. We got them to 0.15%. That's $525/month back in their pocket — $6,300/year.

If you want to know where you stand, reply with your business name and state and I'll send you the statement upload link.

— Scott Allen
Eligibility, underwriting, and card brand rules apply.`,
      },
      {
        num: 5, channel: "sms", delay: "Day 7 — 11 AM",
        copy: `{{contact.firstName}} — one more check-in from Liberty Bancard. If you've been meaning to review your processing costs, this is a good time. Takes 5 minutes to upload, 24 hrs to get results. No cost, no contract. Interested? Reply YES. Reply STOP to opt out.`,
      },
      {
        num: 6, channel: "call", delay: "Day 8 — 9:30 AM local (GHL Voice AI — cold_outbound mode)",
        copy: `"Hi, may I speak with {{contact.firstName}}? [pause] Hi {{contact.firstName}} — this is Liberty Bancard calling about your merchant processing. We specialize in statement reviews that show business owners exactly what they're paying vs. what they should be paying. The review is free, takes about 24 hours, and most merchants are pretty surprised by what we find.\n\nDo you currently accept credit cards at your business? [yes] Are you locked into a current processor contract? [listen] We can work around contracts in most cases. Can I get 15 minutes on your calendar this week to walk you through how it works?"`,
        branch: "Books → stop, tag LB-BOOKING-READY | Interested/can't talk → tag LB-CALLBACK | Not interested → tag LB-COLD-EXIT, exit",
        ghlNote: "GHL: AI Voice Call → cold_outbound mode. Enforce business hours. Add If/Else branches for each disposition. Connect calendar for live booking.",
      },
      {
        num: 7, channel: "voicemail", delay: "Day 8 — if no answer on Step 6",
        copy: `"Hi {{contact.firstName}}, this is Scott with Liberty Bancard. I've sent you a couple of emails about your merchant processing — just wanted to put a voice to the name. If you'd like a free look at what you're paying, give me a call at 888-555-0100 or just reply to one of my emails. Hope to connect soon."`,
      },
      {
        num: 8, channel: "email", delay: "Day 10 — 9 AM",
        subject: "Last thing I'll say about this",
        copy: `{{contact.firstName}},

I've sent a few notes over the past couple of weeks. I know your inbox is busy, so I'll keep this short.

If you accept credit cards and haven't had an independent review of your rates in the last 12 months, there's a reasonable chance you're overpaying. Maybe a little, maybe a lot — I genuinely don't know without seeing the statement.

If you want to find out: [Statement Upload Link]

If now's not the right time: no problem. I'll check back in a few months.

— Scott Allen`,
      },
      {
        num: 9, channel: "sms", delay: "Day 12 — final touch",
        copy: `{{contact.firstName}} — this is my last message from Liberty Bancard. If you ever want a free review of your processing costs, we're here: www.libertybancard.com/statement-review — No pressure. Take care. Reply STOP to opt out.`,
        ghlNote: "After this step: tag contact LB-COLD-EXHAUSTED. Exit workflow.",
      },
    ],
    exitConditions: [
      "Any reply → tag LB-SDR-REPLY-ENGAGED → enroll in Workflow 3 (Reply Engaged)",
      "Appointment booked → tag LB-BOOKING-READY → stop sequence",
      "Statement uploaded → tag LB-STATEMENT-RECEIVED → trigger review workflow",
      "Not interested (voice AI disposition) → tag LB-COLD-EXIT → exit",
      "STOP reply → tag LB-DNC → stop immediately",
      "No engagement after Day 12 → tag LB-COLD-EXHAUSTED → exit",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-COLD-OUTBOUND",
      "Set all email sends to 9 AM contact local timezone using GHL time window",
      "Set all SMS sends to 10–11 AM to avoid quiet hours violations",
      "Configure Voice AI Employee — cold_outbound script",
      "Record and upload cold outbound voicemail audio to GHL Media Library",
      "Add If/Else branch after Day 8 call for each disposition outcome",
      "Add reply detection on all emails and SMS → stop sequence → enroll Workflow 3",
      "Set Day 12 as final step — auto-tag LB-COLD-EXHAUSTED after last SMS",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "reply",
    name: "Workflow 3 — Reply Engaged",
    goal: "Someone replied. Move fast. Get them to a booking or statement within 48 hours.",
    trigger: "Any inbound reply to email or SMS from Workflow 1 or 2. Fire immediately on reply detection.",
    triggerTag: "LB-SDR-REPLY-ENGAGED",
    color: "border-green-500",
    steps: [
      {
        num: 1, channel: "sms", delay: "Immediately (< 5 min after reply detected)",
        copy: `Got your message, {{contact.firstName}}! An account manager will respond within 30 minutes. In the meantime, here's our calendar if you'd like to grab a time: [Calendar Link]`,
        ghlNote: "GHL: Send SMS immediately on workflow trigger. This is the acknowledgment — reply comes before the human reads the conversation.",
      },
      {
        num: 2, channel: "task", delay: "Day 1 — immediate internal alert",
        copy: `🔥 HOT LEAD — Replied to outreach\n{{contact.firstName}} {{contact.lastName}} responded.\nReview their reply in GHL conversation tab before calling.\nGoal: book a 15-min statement review call OR get statement uploaded.\nPersonalize your approach based on what they said.`,
        ghlNote: "GHL: Create Task → high priority → assign to SDR. Alert via SMS or app notification.",
      },
      {
        num: 3, channel: "email", delay: "Day 2 — 9 AM",
        subject: "Re: your message",
        copy: `Hi {{contact.firstName}},

Thanks for getting back to me.

Here's the direct link to upload your statement so we can run the analysis before we talk:
[Statement Upload Link]

Or grab a time on my calendar:
[Calendar Link]

Either way works — just let me know what's easier for you.

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Personalize this email if the rep added a contact note from the Task in Step 2.",
      },
      {
        num: 4, channel: "call", delay: "Day 3 — 10 AM (GHL Voice AI — follow_up_callback mode)",
        copy: `"Hi {{contact.firstName}}, this is Liberty Bancard calling back — you reached out to us recently and I wanted to personally follow up. Did you get a chance to look at the calendar link or the statement upload we sent over?"`,
        branch: "Answered + interested → book appointment, stop sequence | Voicemail → drop VM + continue",
        ghlNote: "GHL: Voice AI → follow_up_callback mode. If appointment booked → tag LB-BOOKING-READY → exit workflow.",
      },
      {
        num: 5, channel: "voicemail", delay: "Day 3 — if no answer on Step 4",
        copy: `"Hi {{contact.firstName}}, Scott from Liberty Bancard again. Just wanted to make sure you didn't get lost in the shuffle — I know you reached out and I want to make sure we take care of you. Give me a call at 888-555-0100 or grab a time on my calendar. I'll send the link again right now."`,
      },
      {
        num: 6, channel: "sms", delay: "Day 5 — final",
        copy: `{{contact.firstName}} — wanted to make sure you didn't fall through the cracks. Still happy to run that free analysis anytime. Calendar: [Link] | Upload: [Link]. Reply STOP to opt out.`,
        ghlNote: "After Day 5 with no booking or statement: tag LB-REPLY-EXHAUSTED. Return to long-term nurture sequence.",
      },
    ],
    exitConditions: [
      "Appointment booked → tag LB-BOOKING-READY → stop sequence",
      "Statement uploaded → tag LB-STATEMENT-RECEIVED → enroll in Workflow 4",
      "STOP reply → tag LB-DNC → stop immediately",
      "No engagement after Day 5 → tag LB-REPLY-EXHAUSTED → enroll in long-term nurture",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-SDR-REPLY-ENGAGED",
      "Set Step 1 SMS to fire within 5 minutes — no wait delay",
      "Create high-priority Task with SDR alert (push notification or internal SMS)",
      "Configure Voice AI → follow_up_callback script",
      "Record and upload reply-engaged voicemail audio",
      "Set appointment booking branch → tag LB-BOOKING-READY → exit workflow",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "statement",
    name: "Workflow 4 — Statement Chase",
    goal: "Prospect agreed to send a statement but hasn't. Get it within 7 days.",
    trigger: "Prospect verbally or by text agreed to send a statement. Manual tag or voice AI disposition trigger.",
    triggerTag: "LB-SDR-STATEMENT-CHASE",
    color: "border-yellow-500",
    steps: [
      {
        num: 1, channel: "sms", delay: "Immediately after tag applied",
        copy: `{{contact.firstName}} — here's the statement upload link we mentioned: [Upload Link]. Takes 2 minutes. We'll have your analysis back within 24 hours. Reply STOP to opt out.`,
        ghlNote: "GHL: Fire immediately on trigger. No wait. This is the instant delivery of the promised link.",
      },
      {
        num: 2, channel: "email", delay: "Day 2 — 9 AM",
        subject: "Upload link + what to look for on your statement",
        copy: `Hi {{contact.firstName}},

Here's the link to upload your statement: [Upload Link]

If you're not sure what to pull, look for:
• Your most recent monthly merchant statement (PDF is fine)
• Any document with "processing volume" or "interchange" on it
• Even a screenshot of the fees section works

Once we have it, our analysis team runs it through our cost model and sends you a side-by-side comparison within 24 hours.

[Upload Link]

— Scott Allen`,
      },
      {
        num: 3, channel: "sms", delay: "Day 3 — 11 AM",
        copy: `Quick check-in — did you get a chance to grab that statement, {{contact.firstName}}? [Upload Link] — we'll take it from here. Reply STOP to opt out.`,
      },
      {
        num: 4, channel: "call", delay: "Day 5 — 10 AM (GHL Voice AI — statement_chase mode)",
        copy: `"Hi {{contact.firstName}}, Scott with Liberty Bancard. We spoke recently about running a statement review for you — just calling to see if you've had a chance to pull it. I can walk you through exactly where to find it if that's helpful. Give me a call back at 888-555-0100 or just reply to one of my texts."`,
        branch: "Has statement → get email/upload now | Can't find it → walk through on call | Not interested → tag LB-COLD-EXIT, exit",
        ghlNote: "GHL: Voice AI → statement_chase mode. Disposition: promised_statement → stay in workflow. Not interested → exit.",
      },
      {
        num: 5, channel: "voicemail", delay: "Day 5 — if no answer on Step 4",
        copy: `"Hi {{contact.firstName}}, this is Scott from Liberty Bancard. Just following up on the statement we were going to review together. If you want to send it over, just reply to one of my texts with a photo or PDF — that works great. Hope to hear from you soon."`,
      },
      {
        num: 6, channel: "email", delay: "Day 7 — final",
        subject: "Leaving the door open",
        copy: `{{contact.firstName}},

I know timing isn't always right. If the statement review is something you want to revisit later, just keep this link: [Upload Link]

We'll be here when you're ready.

— Scott Allen, Liberty Bancard`,
        ghlNote: "After Day 7 with no statement: tag LB-STATEMENT-EXHAUSTED. Move to long-term nurture.",
      },
    ],
    exitConditions: [
      "Statement uploaded → tag LB-STATEMENT-RECEIVED → stop sequence, trigger review workflow",
      "STOP reply → tag LB-DNC → stop immediately",
      "Not interested (voice AI) → tag LB-COLD-EXIT → exit",
      "No statement after Day 7 → tag LB-STATEMENT-EXHAUSTED → long-term nurture",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-SDR-STATEMENT-CHASE",
      "Step 1 SMS fires immediately — zero wait delay",
      "Include statement upload link in every step (use GHL custom value for link)",
      "Configure Voice AI → statement_chase script",
      "Record and upload statement chase voicemail audio",
      "Set webhook or Zapier trigger: statement uploaded → tag LB-STATEMENT-RECEIVED → stop workflow",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "proposal",
    name: "Workflow 5 — Proposal Follow-Up",
    goal: "Close the deal. 7-day decision-focused sequence after sending the savings analysis.",
    trigger: "Deal stage moves to 'Proposal Sent' OR tag LB-SDR-PROPOSAL is applied after analysis is sent.",
    triggerTag: "LB-SDR-PROPOSAL",
    color: "border-purple-500",
    steps: [
      {
        num: 1, channel: "email", delay: "Immediately after proposal sent",
        subject: "Your Liberty Bancard analysis — {{contact.companyName}}",
        copy: `Hi {{contact.firstName}},

Attached is your payment processing analysis. Here's a quick summary:

• Your current effective rate: {{custom.currentRate}}%
• Liberty Bancard rate: {{custom.lbRate}}%
• Estimated monthly savings: \${{custom.monthlySavings}}
• Annualized: \${{custom.annualSavings}}

The next step is a 15-minute call to walk through the numbers and answer any questions. You can book directly here: [Calendar Link]

A few things to know:
• No long-term contract required
• Equipment swap handled at no charge
• First statement review post-switch is on us

Questions? Reply here or call me directly.

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Use custom values for rate/savings fields populated from the platform's proposal data. Attach analysis PDF if generated.",
      },
      {
        num: 2, channel: "sms", delay: "Day 2 — 10 AM",
        copy: `{{contact.firstName}} — just sent over your analysis. Any questions before we jump on a call? Book a time here: [Calendar Link]. Reply STOP to opt out.`,
      },
      {
        num: 3, channel: "task", delay: "Day 3 — internal",
        copy: `Follow up on proposal for {{contact.firstName}} at {{contact.companyName}}.\nReview their analysis numbers in the platform.\nPrepare objection handling:\n• Contract length / ETF concern\n• Equipment swap logistics\n• Batch timing / settlement questions\n• Current processor relationship\n\nGoal: get a decision or a specific objection to address.`,
        ghlNote: "GHL: Create Task → assign to deal owner. High priority.",
      },
      {
        num: 4, channel: "call", delay: "Day 5 — 10 AM (GHL Voice AI — proposal_reminder mode)",
        copy: `"Hi {{contact.firstName}}, Scott with Liberty Bancard. I sent over your processing analysis a few days ago — just calling to see if you had a chance to look it over. Happy to walk through the numbers, answer any questions, or talk through the switch process. Give me a call back or grab a time on my calendar."`,
        branch: "Ready to move → book closing call, tag LB-VERBAL-COMMIT | Objection → note in CRM, stay in workflow | Not interested → tag LB-CLOSED-LOST, exit",
        ghlNote: "GHL: Voice AI → proposal_reminder mode. Disposition branches: booked_meeting → tag LB-BOOKING-READY. not_interested → tag LB-CLOSED-LOST, exit workflow.",
      },
      {
        num: 5, channel: "voicemail", delay: "Day 5 — if no answer on Step 4",
        copy: `"Hi {{contact.firstName}}, Scott from Liberty Bancard. Wanted to touch base on the analysis I sent over — I think there's a real opportunity here and I don't want you to miss it. Give me a call at 888-555-0100 or grab a time on my calendar. I'll send the link right now."`,
      },
      {
        num: 6, channel: "sms", delay: "Day 7 — final",
        copy: `{{contact.firstName}} — following up one last time on your analysis. If the timing's not right, no problem — just let me know. If you're ready to move forward: [Calendar Link]. Reply STOP to opt out.`,
        ghlNote: "After Day 7: if no response, tag LB-PROPOSAL-EXHAUSTED. Move deal stage to Negotiation/Follow-Up. Enroll in long-term nurture.",
      },
    ],
    exitConditions: [
      "Appointment booked / verbal commit → tag LB-VERBAL-COMMIT → stop sequence",
      "Deal closed won → tag LB-CLOSED-WON → enroll in onboarding workflow",
      "Deal closed lost → tag LB-CLOSED-LOST → exit",
      "STOP reply → tag LB-DNC → stop immediately",
      "No response after Day 7 → tag LB-PROPOSAL-EXHAUSTED → long-term nurture",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-SDR-PROPOSAL",
      "Set up custom values: currentRate, lbRate, monthlySavings, annualSavings",
      "Step 1 email fires immediately — attach analysis PDF if available",
      "Configure Voice AI → proposal_reminder script",
      "Record and upload proposal follow-up voicemail audio",
      "Add disposition branches: verbal commit → LB-VERBAL-COMMIT | closed lost → LB-CLOSED-LOST",
      "Connect to onboarding workflow: LB-CLOSED-WON → enroll onboarding sequence",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "onboarding",
    name: "Workflow 6 — Merchant Welcome & App Completion",
    goal: "Get the merchant through the application and document collection within 5 business days of closing.",
    trigger: "Deal stage moves to 'Closed Won' OR tag LB-CLOSED-WON is applied. Fire immediately.",
    triggerTag: "LB-CLOSED-WON",
    color: "border-emerald-500",
    steps: [
      {
        num: 1, channel: "email", delay: "Immediately after Closed Won",
        subject: "Welcome to Liberty Bancard, {{contact.firstName}} — here's what happens next",
        copy: `Hi {{contact.firstName}},

Welcome to Liberty Bancard. We're glad to have you.

Here's exactly what happens from here:

1. Complete your merchant application (takes 5–10 minutes): [Application Link]
2. Our team reviews and approves your account — typically within 1–2 business days.
3. We ship your terminal or configure your payment gateway.
4. You go live. We monitor your first statement and confirm your savings.

A few things to have handy when you fill out the application:
• EIN or SSN
• Voided check or bank letter (for deposits)
• Government-issued ID

If you have questions at any point, reply here or call (888) 555-0100.

Looking forward to saving you money.

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Send Email immediately on LB-CLOSED-WON tag. Use Liberty Bancard welcome template. Attach application link as a GHL custom value.",
      },
      {
        num: 2, channel: "sms", delay: "5 minutes after email",
        copy: `Hi {{contact.firstName}} — welcome to Liberty Bancard! 🎉 Your application link: [App Link]. Takes 5–10 min. Let us know if you have questions. Reply STOP to opt out.`,
        ghlNote: "GHL: Send SMS 5 minutes after Step 1. Short and action-focused — the email has the detail, the SMS is the push.",
      },
      {
        num: 3, channel: "task", delay: "Day 1 — internal",
        copy: `New merchant onboarding started: {{contact.firstName}} {{contact.lastName}} — {{contact.companyName}}\nDeal value: {{opportunity.monetaryValue}}\nAssigned rep: {{user.firstName}}\n\nAction items:\n• Confirm application link was received (check delivery)\n• Verify contact has EIN / voided check ready\n• Note any special requirements from sales call in contact record\n• Set reminder for Day 3 if app not submitted`,
        ghlNote: "GHL: Create Task → assign to deal owner. High priority. Set due date = tomorrow.",
      },
      {
        num: 4, channel: "email", delay: "Day 3 — if application NOT yet submitted",
        subject: "Quick check — did you get the application link?",
        copy: `Hi {{contact.firstName}},

Just checking in — wanted to make sure the application link came through okay.

Here it is again: [Application Link]

Most merchants finish in under 10 minutes. If you hit any questions on the form, reply here and I'll walk you through it.

— Scott Allen`,
        ghlNote: "GHL: Add If/Else condition before this step — check if tag LB-APP-SUBMITTED exists. If yes, skip this step and go to Step 5. If no, send this email.",
      },
      {
        num: 5, channel: "sms", delay: "Day 4 — if application still not submitted",
        copy: `Hi {{contact.firstName}} — just a quick nudge on your Liberty Bancard application. Any questions? Reply here or call us at (888) 555-0100. Direct link: [App Link]. Reply STOP to opt out.`,
        ghlNote: "GHL: Same condition as Step 4 — only send if LB-APP-SUBMITTED tag is NOT present.",
      },
      {
        num: 6, channel: "call", delay: "Day 5 — if application still not submitted (GHL Voice AI — onboarding_assist mode)",
        copy: `"Hi {{contact.firstName}}, this is Liberty Bancard calling about your merchant application. We sent it over a few days ago and wanted to make sure you didn't hit any snags. I can answer questions about the form, or connect you with your account manager right now. Is there anything I can help with to get you started?"`,
        branch: "Submitted/submitting → tag LB-APP-SUBMITTED, exit | Needs help → create task for rep | Not ready yet → log note, stay in workflow",
        ghlNote: "GHL: Voice AI → onboarding_assist mode. Business hours only. Disposition: submitted → LB-APP-SUBMITTED; needs_help → create priority task.",
      },
    ],
    exitConditions: [
      "Application submitted → tag LB-APP-SUBMITTED → stop sequence → enroll in Workflow 7 (Approval & Go-Live)",
      "STOP reply → tag LB-DNC → stop immediately",
      "No app after Day 7 → tag LB-ONBOARDING-STALLED → alert assigned rep",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-CLOSED-WON",
      "Set application link as a GHL custom value (reusable across all templates)",
      "Step 1 email fires immediately — zero wait delay",
      "Step 2 SMS fires 5 minutes after Step 1",
      "Add If/Else branches on Steps 4–6: check for LB-APP-SUBMITTED tag before sending",
      "Configure Voice AI → onboarding_assist script",
      "Set application submission webhook: when app submitted → tag LB-APP-SUBMITTED → exit workflow → enroll WF7",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "golive",
    name: "Workflow 7 — Approval, Go-Live & Terminal Setup",
    goal: "Take the merchant from approved application to first live transaction. Confirm savings on first statement.",
    trigger: "Merchant application approved by underwriting. Platform applies tag LB-MERCHANT-APPROVED.",
    triggerTag: "LB-MERCHANT-APPROVED",
    color: "border-teal-500",
    steps: [
      {
        num: 1, channel: "email", delay: "Immediately on approval",
        subject: "You're approved! Here's your next step, {{contact.firstName}}",
        copy: `Hi {{contact.firstName}},

Great news — your Liberty Bancard merchant account has been approved.

Your Merchant ID (MID): {{custom.merchantId}}

Here's what happens next:

If you're using a physical terminal:
→ Your equipment will ship within 1–2 business days. Track it here: [Tracking Link]
→ Setup takes about 15 minutes. We'll send a step-by-step guide when it ships.

If you're using a payment gateway (online):
→ Your gateway credentials are in the Merchant Portal: [Portal Link]
→ Our team will schedule a 30-minute integration call with you.

Merchant Portal access (manage transactions, view statements, update banking):
[Portal Link] — Password reset link was sent to this email address.

First question or issue: call (888) 555-0100 or reply here. We answer fast.

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Send Email immediately on LB-MERCHANT-APPROVED. Use custom value for merchantId and portal link. This email must fire within minutes of approval — merchant is expecting it.",
      },
      {
        num: 2, channel: "sms", delay: "10 minutes after approval email",
        copy: `{{contact.firstName}} — you're approved! 🎉 MID: {{custom.merchantId}}. Portal: [Link]. Terminal ships in 1–2 days. Questions? Call (888) 555-0100. Reply STOP to opt out.`,
        ghlNote: "GHL: 10-minute delay after Step 1. Short confirmation with MID — merchants screenshot this.",
      },
      {
        num: 3, channel: "email", delay: "Day 2 — terminal shipped (conditional)",
        subject: "Your terminal shipped — {{contact.companyName}} setup guide inside",
        copy: `Hi {{contact.firstName}},

Your payment terminal shipped today. Tracking: [Tracking Link]

Once it arrives, here's how to get set up in 15 minutes:

1. Plug in the terminal (power + ethernet or WiFi)
2. Follow the on-screen setup wizard — it will auto-configure your merchant settings
3. Run a $1.00 test transaction with your own card to confirm it's processing
4. Call us at (888) 555-0100 if anything looks off

You'll process your first live transaction with Liberty Bancard rates from the moment it's configured. Your first statement will arrive in about 30 days — we'll send a savings summary at that point.

[Video: How to set up your terminal — 4 min]

— Liberty Bancard Onboarding Team`,
        ghlNote: "GHL: Fire when terminal label is created/shipped. If gateway-only merchant, replace this step with a 'gateway credentials' email instead. Use If/Else on custom field: terminal_type = physical → send this email; gateway → send gateway setup email.",
      },
      {
        num: 4, channel: "task", delay: "Day 3 — internal",
        copy: `Go-Live Check: {{contact.firstName}} at {{contact.companyName}}\n• Confirm terminal delivered or gateway access granted\n• Check merchant portal — has the merchant logged in?\n• Any open support tickets?\n• If no activity 3 days post-ship, call merchant proactively`,
        ghlNote: "GHL: Create Task → assign to onboarding rep. Due = Day 3 after approval.",
      },
      {
        num: 5, channel: "sms", delay: "Day 5 — go-live confirmation",
        copy: `Hi {{contact.firstName}} — checking in! Have you run your first transaction yet? Reply YES and you're all set. Need help? Call (888) 555-0100 or reply here. Reply STOP to opt out.`,
        ghlNote: "GHL: Day 5. If first transaction detected (via webhook or manual tag LB-FIRST-TXN), skip this step. Otherwise send.",
      },
      {
        num: 6, channel: "email", delay: "Day 32 — first statement follow-up",
        subject: "Your first Liberty Bancard statement — here's your savings breakdown",
        copy: `Hi {{contact.firstName}},

Your first full month of processing with Liberty Bancard is done. Here's a summary:

• Volume processed: {{custom.month1Volume}}
• Your effective rate this month: {{custom.month1Rate}}%
• Estimated savings vs. your previous processor: \${{custom.month1Savings}}

You can see the full statement breakdown in your Merchant Portal: [Portal Link]

A couple of things to note:
• If your volume was lower this month than expected, your effective rate may be slightly higher — interchange is tiered.
• If you have high-ticket transactions (over $500), we can review the card mix and see if there's more to optimize.

We're working for you every month. Let me know if you have any questions.

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Fire on Day 32 after LB-MERCHANT-APPROVED. Requires custom values month1Volume, month1Rate, month1Savings populated from the platform's statement reconciliation data. If data isn't ready, delay to Day 35.",
      },
    ],
    exitConditions: [
      "First transaction processed → tag LB-FIRST-TXN → mark onboarding complete",
      "Day 32 savings email sent → tag LB-MERCHANT-ACTIVE → enroll in Workflow 8 (Retention)",
      "Merchant unreachable after Day 7 → tag LB-GOLIVE-STALLED → escalate to manager",
      "STOP reply → tag LB-DNC → stop immediately",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-MERCHANT-APPROVED",
      "Set custom values: merchantId, portalLink, trackingLink, month1Volume, month1Rate, month1Savings",
      "Step 1 fires immediately — test with a sample approval to confirm sub-minute delivery",
      "Add If/Else on Step 3: terminal_type field → physical vs. gateway → different email content",
      "Connect shipping webhook: label created → tag LB-TERMINAL-SHIPPED → trigger Step 3",
      "Day 32 email requires statement reconciliation data — coordinate with platform data feed",
      "After Day 32 email: apply tag LB-MERCHANT-ACTIVE → auto-enroll in Workflow 8",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "retention",
    name: "Workflow 8 — Retention, NPS & Referral",
    goal: "Keep active merchants engaged, identify at-risk accounts, and generate referrals from satisfied merchants.",
    trigger: "Tag LB-MERCHANT-ACTIVE applied after first statement delivered (Day 32+ post-go-live).",
    triggerTag: "LB-MERCHANT-ACTIVE",
    color: "border-sky-500",
    steps: [
      {
        num: 1, channel: "email", delay: "Day 30 — NPS survey",
        subject: "Quick question about your first month, {{contact.firstName}}",
        copy: `Hi {{contact.firstName}},

You've been processing with Liberty Bancard for about a month now — I wanted to check in.

On a scale of 0–10, how likely are you to recommend Liberty Bancard to another business owner?

[0–6] [7–8] [9–10]

(Click your score — takes 10 seconds. We read every response.)

If anything isn't working the way you expected, reply here and I'll personally make sure it's resolved.

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Send NPS email at Day 30. Connect NPS link to a GHL survey or external NPS tool. Set If/Else on score: 9–10 → tag LB-NPS-PROMOTER → enroll in referral sequence (Step 3). 7–8 → tag LB-NPS-PASSIVE. 0–6 → tag LB-NPS-DETRACTOR → create urgent task for account manager.",
      },
      {
        num: 2, channel: "task", delay: "Day 30 — NPS detractor alert (conditional)",
        copy: `⚠️ NPS DETRACTOR — Immediate follow-up required\n{{contact.firstName}} at {{contact.companyName}} scored 0–6 on NPS survey.\nContact within 24 hours — identify the issue and resolve it before they churn.\nCheck: terminal issues, unexpected fees, settlement timing, support ticket history.`,
        ghlNote: "GHL: This task only fires if NPS score is 0–6 (tag LB-NPS-DETRACTOR applied). Assign to account manager. High priority. Due = today.",
      },
      {
        num: 3, channel: "email", delay: "Day 60 — savings recap",
        subject: "Your 60-day savings report — {{contact.companyName}}",
        copy: `Hi {{contact.firstName}},

Two months in. Here's how your savings are stacking up:

• Total savings since switching: \${{custom.cumulativeSavings}}
• Your average effective rate: {{custom.avgRate}}%
• Transactions processed: {{custom.txnCount}}

Annualized, you're on track to save approximately \${{custom.annualProjection}} this year vs. your previous processor.

One thing worth knowing: if your volume grows, your rate doesn't. You're already on our best interchange-plus pricing.

If you know another business owner who's been complaining about their processing fees, we'll handle their statement review and you'll earn a referral bonus when they switch.

[Refer a merchant → earn \${{custom.referralBonus}}]

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Day 60. Requires custom values cumulativeSavings, avgRate, txnCount, annualProjection, referralBonus from platform data feed. If data unavailable, send a simplified 'checking in' version without the numbers.",
      },
      {
        num: 4, channel: "sms", delay: "Day 90 — referral push",
        copy: `Hi {{contact.firstName}} — 3 months in and going strong! Know a business owner who could save on processing? Reply REFER and I'll send you the details on our referral program. Reply STOP to opt out.`,
        ghlNote: "GHL: Day 90 SMS. Short and conversational. If they reply REFER → apply tag LB-REFERRAL-INTERESTED → assign task to rep to send referral program details.",
      },
      {
        num: 5, channel: "email", delay: "Day 180 — 6-month check-in",
        subject: "6 months with Liberty Bancard — a quick check-in",
        copy: `Hi {{contact.firstName}},

Six months in — and your account is in great shape.

Running total saved: \${{custom.cumulativeSavings}}

A few things we're monitoring for you:
• Your card mix is {{custom.cardMix}}% premium cards — we're watching for any interchange creep
• Chargeback rate: {{custom.chargebackRate}}% (industry average: 0.6%)

If your business has grown and you're processing significantly more volume now, it's worth a quick call to review your setup. Volume thresholds can unlock additional rate improvements.

Reply here or call (888) 555-0100.

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Day 180 from LB-MERCHANT-ACTIVE. Continue on 90-day cadence after this: Day 270, Day 360 (annual review). Requires platform data feed for metrics.",
      },
    ],
    exitConditions: [
      "NPS Detractor (0–6) → tag LB-NPS-DETRACTOR → urgent task + stay in sequence",
      "NPS Promoter (9–10) → tag LB-NPS-PROMOTER → referral outreach added",
      "Account cancellation → tag LB-MERCHANT-CHURNED → exit → enroll in Workflow 9 (Win-Back)",
      "STOP reply → tag LB-DNC → stop immediately",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-MERCHANT-ACTIVE",
      "Day 30 NPS email — connect NPS score click to If/Else branches in GHL",
      "NPS Detractor (0–6) branch: apply LB-NPS-DETRACTOR → high-priority task → rep contacts within 24h",
      "NPS Promoter (9–10) branch: apply LB-NPS-PROMOTER → referral email sequence",
      "Day 60/180 emails require platform data feed for savings figures — set up custom values",
      "Day 90 SMS: REFER reply detection → tag LB-REFERRAL-INTERESTED → rep task",
      "Churn detection: cancellation event → tag LB-MERCHANT-CHURNED → exit WF8 → enroll WF9",
      "Continue sequence on 90-day cadence after Day 180 (quarterly touch)",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
  {
    id: "winback",
    name: "Workflow 9 — Win-Back (Churned Merchant)",
    goal: "Re-engage churned merchants within 90 days of cancellation. Target: 15% win-back rate.",
    trigger: "Merchant account cancelled or ported away. Platform applies tag LB-MERCHANT-CHURNED.",
    triggerTag: "LB-MERCHANT-CHURNED",
    color: "border-rose-500",
    steps: [
      {
        num: 1, channel: "email", delay: "Day 3 after churn — cooling-off period",
        subject: "We're sorry to see you go — and we want to make it right",
        copy: `Hi {{contact.firstName}},

We saw that your Liberty Bancard account has been closed. I'm not going to pretend that's not disappointing — but I do want to understand what happened.

If there was something we could have done better — a fee that surprised you, a support issue we didn't resolve, or a competitor offer we should have matched — I'd genuinely like to know.

Reply to this email. I read every response personally.

If it's a rate issue: I'd like 10 minutes to show you what we can do.
If it's a service issue: I want to fix it, even if you don't come back.

No pitch. Just a conversation.

— Scott Allen, Liberty Bancard
(888) 555-0100`,
        ghlNote: "GHL: 3-day delay after LB-MERCHANT-CHURNED. Do NOT send immediately — give the merchant cooling-off time. Tone is empathetic, not sales-focused. Reply detection → tag LB-WINBACK-REPLIED → create priority task for account manager.",
      },
      {
        num: 2, channel: "task", delay: "Day 3 — internal",
        copy: `Churned merchant — review exit reason\n{{contact.firstName}} at {{contact.companyName}} cancelled their account.\nAction: Review contact record for recent support tickets, complaint notes, or fee disputes.\nIdentify exit reason BEFORE any win-back outreach.\nGoal: personalize the re-engagement if we attempt it.`,
        ghlNote: "GHL: Create Task simultaneously with Step 1. Assign to original rep or account manager.",
      },
      {
        num: 3, channel: "email", delay: "Day 14 — competitive offer",
        subject: "One thing before you're fully set up elsewhere, {{contact.firstName}}",
        copy: `Hi {{contact.firstName}},

I know you've moved on, and I respect that. But I'd feel like I wasn't doing my job if I didn't share one thing first.

We've recently renegotiated our interchange-plus pricing floor. The rate we can offer you today is lower than what we had you on when you left.

I'm not asking you to cancel your new setup. But if you haven't fully ported over yet, or if you want to run a quick side-by-side on what your statement would look like with our current pricing, I'm happy to do that — no obligation, takes 20 minutes.

If the answer is still no, I understand. I'll leave you alone after this.

But if there's any chance the numbers work: [Calendar Link]

— Scott Allen, Liberty Bancard`,
        ghlNote: "GHL: Day 14. If LB-WINBACK-REPLIED tag is already present (they responded to Step 1), replace this with a more personalized follow-up from the rep directly — not this automated email. Add If/Else check.",
      },
      {
        num: 4, channel: "sms", delay: "Day 30 — final touch",
        copy: `Hi {{contact.firstName}} — one last message from Liberty Bancard. If you ever want to revisit your processing costs, we're here. Our rates have improved since you left. No pressure — just keeping the door open. www.libertybancard.com. Reply STOP to opt out.`,
        ghlNote: "GHL: Day 30. This is the final automated touchpoint. After this: tag LB-WINBACK-EXHAUSTED. Remove from all active sequences. Note in contact record: win-back attempted, not recovered.",
      },
    ],
    exitConditions: [
      "Reply received → tag LB-WINBACK-REPLIED → rep handles manually → exit sequence",
      "Re-signs / reactivates → tag LB-MERCHANT-APPROVED → enroll in WF7 → exit",
      "STOP reply → tag LB-DNC → stop immediately",
      "No response after Day 30 → tag LB-WINBACK-EXHAUSTED → move to annual nurture",
    ],
    checklist: [
      "Create GHL Workflow — trigger: Contact Tag Added = LB-MERCHANT-CHURNED",
      "Step 1 email has a 3-day delay — do NOT fire immediately on churn tag",
      "Reply detection on Step 1: LB-WINBACK-REPLIED → create urgent rep task → stop automation",
      "Step 3 If/Else: if LB-WINBACK-REPLIED exists → skip automated email (rep handles manually)",
      "After Day 30 SMS: apply LB-WINBACK-EXHAUSTED → log outcome in contact record",
      "Churn reason tracking: ensure reps complete the exit reason field before closing account",
      "Register GHL Workflow ID in platform at /dashboard/ghl-workflows",
    ],
  },
];

// ─── GHL Build Checklist (global) ─────────────────────────────────────────────

const GLOBAL_CHECKLIST = [
  { section: "Voice AI Setup", items: [
    "Go to GHL → Settings → AI Employee → Create new employee",
    "Select Phone channel → paste the Voice AI script for each workflow",
    "Set business hours: Mon–Fri 9 AM–5 PM (use contact's local timezone)",
    "Connect GHL calendar for live appointment booking during calls",
    "Configure human handoff: phrases 'real person', 'manager', 'speak to someone', 'not interested', frustration detected",
    "Set call recording ON for compliance and coaching",
  ]},
  { section: "Voicemail Drops", items: [
    "Record 5 audio files (one per workflow) — keep each under 25 seconds",
    "Upload to GHL → Marketing → Files & Media",
    "In each workflow, add 'Send Voicemail' action and select the correct audio file",
    "Voicemail drop fires ONLY on the voicemail branch (not answered branch)",
  ]},
  { section: "AI SMS Agent (GHL AI Employee)", items: [
    "Go to GHL → Settings → AI Employee → Create new employee",
    "Select Text/SMS channel",
    "Paste the Liberty Bancard AI system prompt (available in platform at /dashboard/ghl-workflows → AI Prompts tab)",
    "Set human handoff: 'real person', 'agent', 'speak to someone', 'human', ready to apply",
    "Connect GHL calendar for live appointment booking via SMS",
    "Activate on Workflow 1 Day 3 AI Conversation step",
  ]},
  { section: "Smart Lists (GHL)", items: [
    "Hot Inbound (Today): Tag = LB-INBOUND-NEW, Tag added last 24h",
    "Replied — Needs Response: Tag = LB-SDR-REPLY-ENGAGED, last 48h",
    "Statement Pending: Tag = LB-SDR-STATEMENT-CHASE",
    "Proposal Out: Pipeline Stage = Proposal Sent",
    "Cold Active: Tag = LB-COLD-OUTBOUND, does NOT have LB-COLD-EXIT",
    "DNC: Tag = LB-DNC (remove from all active sequences)",
  ]},
  { section: "Platform Integration", items: [
    "Go to /dashboard/ghl-workflows in this platform",
    "Paste each GHL Workflow ID next to the matching sequence name",
    "This enables auto-enrollment: platform detects qualifying events → calls GHL API → GHL executes",
    "Test each workflow: add a test contact → manually apply trigger tag → verify steps fire in GHL",
  ]},
  { section: "Compliance", items: [
    "Confirm SMS opt-in language on all web forms before launching cold outbound",
    "Verify STOP/UNSUBSCRIBE handling is active in GHL (automatic in GHL SMS)",
    "Add compliance footer to all emails: 'Eligibility, underwriting, and card brand rules apply.'",
    "AI Voice calls must identify as AI if asked directly — verify this is in all voice scripts",
    "Respect quiet hours: no calls before 9 AM or after 5 PM in prospect's local timezone",
    "Do not call contacts tagged LB-DNC under any circumstance",
  ]},
];

// ─── Tag reference ─────────────────────────────────────────────────────────────

const TAG_TABLE = [
  { tag: "LB-INBOUND-NEW",           trigger: "Any form submission / chat inbound",              workflow: "Workflow 1 — Speed-to-Lead" },
  { tag: "LB-COLD-OUTBOUND",         trigger: "SDR enrichment / manual upload / bulk import",    workflow: "Workflow 2 — Cold Outbound" },
  { tag: "LB-SDR-REPLY-ENGAGED",     trigger: "Any inbound email or SMS reply",                  workflow: "Workflow 3 — Reply Engaged" },
  { tag: "LB-SDR-STATEMENT-CHASE",   trigger: "Prospect agreed to send statement",               workflow: "Workflow 4 — Statement Chase" },
  { tag: "LB-SDR-PROPOSAL",          trigger: "Analysis/proposal sent to prospect",              workflow: "Workflow 5 — Proposal Follow-Up" },
  { tag: "LB-BOOKING-READY",         trigger: "Appointment booked (any channel)",                workflow: "EXIT — stop all active sequences" },
  { tag: "LB-STATEMENT-RECEIVED",    trigger: "Statement uploaded to platform",                  workflow: "EXIT — trigger review workflow" },
  { tag: "LB-VERBAL-COMMIT",         trigger: "Prospect verbally agreed to proceed",             workflow: "EXIT — move to closing" },
  { tag: "LB-CLOSED-WON",            trigger: "Deal closed / approved",                         workflow: "Workflow 6 — Merchant Welcome" },
  { tag: "LB-CLOSED-LOST",           trigger: "Deal lost / not interested",                     workflow: "EXIT — long-term nurture" },
  { tag: "LB-APP-SUBMITTED",         trigger: "Merchant completes application form",             workflow: "EXIT WF6 → Workflow 7 — Go-Live" },
  { tag: "LB-ONBOARDING-STALLED",    trigger: "No app submitted after 7 days",                  workflow: "Alert — rep follow-up required" },
  { tag: "LB-MERCHANT-APPROVED",     trigger: "Underwriting approves merchant account",          workflow: "Workflow 7 — Approval & Go-Live" },
  { tag: "LB-FIRST-TXN",             trigger: "First live transaction processed",                workflow: "Onboarding milestone — log only" },
  { tag: "LB-GOLIVE-STALLED",        trigger: "No terminal activity 7 days post-approval",      workflow: "Alert — escalate to manager" },
  { tag: "LB-MERCHANT-ACTIVE",       trigger: "Day 32 post-go-live — first statement delivered", workflow: "Workflow 8 — Retention & NPS" },
  { tag: "LB-NPS-PROMOTER",          trigger: "NPS score 9–10",                                 workflow: "Referral outreach sequence" },
  { tag: "LB-NPS-PASSIVE",           trigger: "NPS score 7–8",                                  workflow: "Passive — continue nurture" },
  { tag: "LB-NPS-DETRACTOR",         trigger: "NPS score 0–6",                                  workflow: "URGENT — rep contacts within 24h" },
  { tag: "LB-REFERRAL-INTERESTED",   trigger: "Merchant replies REFER to SMS",                  workflow: "Rep sends referral program details" },
  { tag: "LB-MERCHANT-CHURNED",      trigger: "Account cancelled / ported away",                workflow: "Workflow 9 — Win-Back" },
  { tag: "LB-WINBACK-REPLIED",       trigger: "Churned merchant replies to win-back outreach",   workflow: "EXIT automation — rep handles" },
  { tag: "LB-WINBACK-EXHAUSTED",     trigger: "No response after Day 30 win-back",              workflow: "Annual nurture — no further outreach" },
  { tag: "LB-DNC",                   trigger: "STOP reply / manual DNC flag",                   workflow: "GLOBAL STOP — all sequences forever" },
];

// ─── CopyBlock ────────────────────────────────────────────────────────────────

function CopyBlock({ text, label }: { text: string; label?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      toast({ title: "Copied to clipboard" });
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="relative group">
      {label && <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">{label}</p>}
      <pre className="bg-muted/60 border rounded-md p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto max-h-64 overflow-y-auto">
        {text}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 p-0"
        onClick={handleCopy}
        data-testid="btn-copy-block"
        aria-label="Copy to clipboard"
      >
        {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

// ─── Step Card ────────────────────────────────────────────────────────────────

function StepCard({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const meta = CHANNEL_META[step.channel];
  const Icon = meta.icon;

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-start gap-3 p-4 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(!open)}
        data-testid={`btn-step-${step.num}`}
      >
        <div className="flex items-center justify-center h-7 w-7 rounded-full bg-muted border text-xs font-bold shrink-0 mt-0.5">
          {step.num}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={`${meta.color} gap-1 text-xs`}>
              <Icon className="h-3 w-3" /> {meta.label}
            </Badge>
            <span className="text-xs text-muted-foreground">{step.delay}</span>
          </div>
          {step.subject && (
            <p className="text-sm font-medium mt-1 truncate">Subject: {step.subject}</p>
          )}
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-1" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t bg-muted/20">
          <div className="pt-3">
            {step.subject && (
              <div className="mb-3">
                <CopyBlock text={step.subject} label="Subject Line" />
              </div>
            )}
            <CopyBlock text={step.copy} label={step.channel === "call" || step.channel === "voicemail" ? "Script" : "Message Copy"} />
          </div>

          {step.branch && (
            <div className="flex gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <ArrowRight className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-0.5">Branch Logic</p>
                <p className="text-xs text-amber-700 dark:text-amber-400">{step.branch}</p>
              </div>
            </div>
          )}

          {step.ghlNote && (
            <div className="flex gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
              <Settings className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-0.5">GHL Configuration</p>
                <p className="text-xs text-blue-700 dark:text-blue-400">{step.ghlNote}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Workflow Panel ────────────────────────────────────────────────────────────

function WorkflowPanel({ wf }: { wf: Workflow }) {
  const [checkState, setCheckState] = useState<Record<number, boolean>>({});

  function toggle(i: number) {
    setCheckState(prev => ({ ...prev, [i]: !prev[i] }));
  }

  const done = Object.values(checkState).filter(Boolean).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={`border-l-4 ${wf.color} pl-4`}>
        <p className="text-sm text-muted-foreground font-medium">{wf.goal}</p>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <Badge variant="outline" className="gap-1 font-mono text-xs">
            <Tag className="h-3 w-3" /> Trigger Tag: {wf.triggerTag}
          </Badge>
          <span className="text-xs text-muted-foreground">{wf.trigger}</span>
        </div>
      </div>

      {/* Steps */}
      <div>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Zap className="h-4 w-4 text-yellow-500" /> Workflow Steps
          <span className="text-xs text-muted-foreground font-normal">(click any step to expand copy &amp; config)</span>
        </h3>
        <div className="space-y-2">
          {wf.steps.map(step => <StepCard key={step.num} step={step} />)}
        </div>
      </div>

      {/* Exit conditions */}
      <div className="border rounded-lg p-4 bg-muted/30">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-red-500" /> Exit Conditions
        </h3>
        <ul className="space-y-1.5">
          {wf.exitConditions.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
              <ArrowRight className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground/60" />
              {c}
            </li>
          ))}
        </ul>
      </div>

      {/* Checklist */}
      <div className="border rounded-lg p-4">
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-green-500" /> Build Checklist
          <Badge variant="secondary" className="ml-auto">{done}/{wf.checklist.length} done</Badge>
        </h3>
        <p className="text-xs text-muted-foreground mb-3">Check off each item as you configure it in GHL.</p>
        <ul className="space-y-2">
          {wf.checklist.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5 cursor-pointer" onClick={() => toggle(i)} data-testid={`check-${wf.id}-${i}`}>
              <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors ${checkState[i] ? "bg-green-500 border-green-500" : "border-muted-foreground/40"}`}>
                {checkState[i] && <CheckCircle2 className="h-3 w-3 text-white" />}
              </div>
              <span className={`text-xs ${checkState[i] ? "line-through text-muted-foreground" : ""}`}>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── Admin Setup checklist section ─────────────────────────────────────────────

function AdminCheckSection({ sectionIndex, title, color, items }: {
  sectionIndex: number;
  title: string;
  color: string;
  items: string[];
}) {
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const done = Object.values(checked).filter(Boolean).length;
  return (
    <Card className={`border-l-4 ${color}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span>{title}</span>
          <Badge variant="secondary">{done}/{items.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {items.map((item, ii) => (
            <li
              key={ii}
              className="flex items-start gap-2.5 cursor-pointer"
              onClick={() => setChecked(prev => ({ ...prev, [ii]: !prev[ii] }))}
              data-testid={`admin-check-${sectionIndex}-${ii}`}
            >
              <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors ${checked[ii] ? "bg-green-500 border-green-500" : "border-muted-foreground/40"}`}>
                {checked[ii] && <CheckCircle2 className="h-3 w-3 text-white" />}
              </div>
              <span className={`text-xs leading-relaxed ${checked[ii] ? "line-through text-muted-foreground" : ""}`}>{item}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ─── AI Employee Tab ──────────────────────────────────────────────────────────

const VOICE_AI_SYSTEM_PROMPT = `IDENTITY
You are Alex, the Liberty Bancard AI sales representative. You work on behalf of Scott Allen and the Liberty Bancard team. You are NOT ChatGPT, NOT an OpenAI product, and NOT a generic AI. If anyone asks "Are you ChatGPT?" or "Are you an AI?", you say: "I'm Alex, Liberty Bancard's AI sales assistant. I can answer most questions right now, or connect you with Scott directly."

VOICE TONE & PACING
- Speak naturally and conversationally. This is a phone call — short sentences, no bullet points, no lists.
- Pause naturally after questions. Do not rush.
- Mirror the caller's energy. If they're warm and friendly, be warm. If they're brief and businesslike, be brief.
- Never say "Absolutely!", "Great question!", "Certainly!", or similar filler affirmations.
- Lead with their name when re-engaging: "So {{contact.firstName}}, ..."

WHAT YOU CAN DO ON THIS CALL
- Answer general questions about payment processing fees (interchange, assessments, processor markup, effective rate).
- Explain how Liberty Bancard's pricing works: interchange-plus, flat-rate comparison, cash discount, surcharge programs.
- Walk a prospect through what a statement review involves: what to send, what we analyze, what the output shows.
- Explain the approval timeline: application 5–10 minutes, funding in 1–2 business days for most merchants.
- Address common objections: locked in a contract, happy with current rates, using Square or Stripe, no time to switch.
- Book an appointment directly on the calendar.
- Transfer the call to a live team member.

WHAT YOU MUST NEVER DO
- Never quote a specific rate or fee without a statement on file. Say: "I can't give you a number without seeing your statement — every business is different."
- Never guarantee savings. Say: "Our average analysis shows merchants are overpaying by 0.3–0.8% on volume. I can't confirm your number without the statement."
- Never disparage a competitor by name.
- Never give legal, tax, or compliance advice.
- Never pretend to be a human. If asked directly "Am I talking to a real person?", say: "I'm Liberty Bancard's AI assistant, Alex. Want me to connect you with Scott directly?"

CALL MODES
You may be initialized in one of these modes. Adjust your opening accordingly:

intro_qualification: You are following up on a form the caller just submitted. Open: "Hi [name], this is Alex with Liberty Bancard — I'm calling about the request you just submitted. Got a quick minute?"

cold_outbound: This is an outbound prospecting call. Open: "Hi [name], this is Alex calling on behalf of Scott Allen at Liberty Bancard. We help businesses like yours lower their payment processing costs. Is this a good time for 60 seconds?"

follow_up_callback: The prospect reached out or replied to outreach. Open: "Hi [name], Alex from Liberty Bancard — you had reached out to us and I wanted to personally follow up. Did you get a chance to look at the calendar link we sent?"

statement_chase: The prospect agreed to send a statement but hasn't yet. Open: "Hi [name], Alex from Liberty Bancard — we were expecting your statement and just wanted to make sure you didn't run into any snags. Is it still something you want to do?"

proposal_followup: The analysis has been sent. Open: "Hi [name], Alex from Liberty Bancard. Scott sent over the processing analysis — I'm calling to see if you had a chance to look it over and answer any questions."

onboarding_assist: The merchant is in the application process. Open: "Hi [name], Alex from Liberty Bancard. You're in the middle of your application and I just wanted to make sure everything's going smoothly. Anything I can help with?"

OBJECTION HANDLING
- "I'm locked in a contract": "When does it end? We can often cover early termination fees up to $500. In the meantime, send us a statement — if the savings are big enough, we might cover the exit cost entirely."
- "My rates are fine": "Most merchants say that before seeing a side-by-side comparison. The only way to know is to send the statement — takes us about 24 hours to run it, no cost."
- "I use Square / Stripe": "Square charges 2.6% plus 10 cents on card-present. Depending on your volume, interchange-plus can be meaningfully lower. Worth a quick look."
- "I'm not interested": Acknowledge it and offer one reason to reconsider. If they decline again: "Understood. I'll let Scott know. If anything changes, we're here." Then end the call politely.
- "How much can I save?": "I can't give you a number without your statement. What I can say is our average analysis shows 0.3 to 0.8 percent above what merchants should be paying. On a hundred thousand a month, that's three to eight hundred dollars."

HUMAN HANDOFF TRIGGERS — transfer immediately when:
1. Prospect says any version of: speak to a person, talk to someone, real person, agent, human, manager.
2. Prospect wants to negotiate pricing directly.
3. Prospect raises a compliance, legal, or regulatory question you cannot fully answer.
4. Prospect expresses frustration or anger (two or more frustration signals in the same call).
5. Prospect is ready to apply or sign right now.
When handing off: "Let me connect you with Scott directly — one moment."

CALL CLOSE
If appointment booked: "Perfect — you'll get a calendar confirmation at the email we have on file. Scott will be ready with notes on your business when you talk. Have a great day."
If statement agreed: "Excellent — reply to the text or email we send right after this call with a PDF or photo of your statement. We'll have the analysis back to you within 24 hours."
If not interested: "No problem at all. If anything changes, Scott's info is on our website. Take care, [name]."

COMPLIANCE FOOTER (say only if directly asked about guarantees or commitments):
"Eligibility, underwriting, and card brand rules apply. Rates are subject to the statement review and approval process."`;

const SMS_AI_SYSTEM_PROMPT = `You are Alex, the Liberty Bancard AI sales assistant handling SMS conversations.

IDENTITY
You represent Liberty Bancard. You are NOT ChatGPT, NOT an OpenAI product. If asked "Are you an AI?" say: "I'm Alex, Liberty Bancard's AI assistant. I can answer questions or connect you with Scott directly."

SMS RULES — CRITICAL
- Every reply must be under 160 characters when possible. Never exceed 320 characters (2 SMS segments).
- No bullet points, no numbered lists, no markdown — plain conversational text only.
- One idea per message. If you need to say multiple things, send them as separate short messages.
- Always end the first message to a new contact with: Reply STOP to opt out.

WHAT YOU CAN DO
- Answer questions about processing fees, interchange, markup, cash discount, and surcharge programs.
- Explain what a statement review involves and how to send a statement.
- Provide the statement upload link: [Statement Upload Link]
- Provide the calendar booking link: [Calendar Link]
- Qualify interest and capture intent.
- Escalate to a human SDR when needed.

WHAT YOU MUST NEVER DO
- Never quote a specific rate without a statement.
- Never guarantee savings.
- Never disparage competitors by name.
- Never give legal or compliance advice.
- Never send a message over 320 characters.

TONE
Conversational, direct, brief. No corporate speak. No filler phrases ("Absolutely!", "Great question!"). Sound like a knowledgeable colleague texting — not a marketing bot.

OBJECTION HANDLING (keep replies short)
- "Not interested": "No problem. If you ever want a free look at your rates, we're here: [Upload Link]. Take care."
- "I'm locked in a contract": "Understood — when's it up? We sometimes cover exit fees. Worth a quick look either way."
- "My rates are fine": "Most merchants say that before seeing their actual markup. Free to check: [Upload Link]"
- "I use Square": "Square is 2.6%+. Interchange-plus is usually lower. 2 min to check: [Upload Link]"
- "How much can I save?": "Can't say without your statement. Avg is 0.3-0.8% overpayment. Free to find out: [Upload Link]"

HUMAN HANDOFF TRIGGERS — stop replying and flag for human when:
1. "Speak to a person" / "real agent" / "human" / "manager"
2. Ready to apply or sign now
3. Angry or frustrated (explicit or escalating)
4. Complex pricing negotiation
5. Compliance or legal question
When handing off, send: "Let me connect you with Scott directly. He'll follow up within 30 minutes."

KNOWLEDGE BASE
When asked factual questions about Liberty Bancard services, answer using the Knowledge Base attached to this AI Employee in GHL.

COMPLIANCE: Always include "Reply STOP to opt out." on the first message to any contact.`;

const KB_ARTICLES = [
  {
    title: "What is a free statement analysis and what does it show?",
    body: `Liberty Bancard's free statement analysis is a side-by-side cost comparison between what you currently pay your processor and what those same transactions would cost at Liberty Bancard.

What we look at:
- Your effective rate (total fees divided by total volume — the real number, not the quoted rate)
- Your processor's markup above interchange (the part that's negotiable)
- Fee categories: interchange, assessments, processor markup, monthly fees, PCI fees, batch fees
- Your card mix (debit vs. credit vs. rewards cards — each costs a different amount)

What we send back:
- A line-by-line breakdown of current costs
- A projected cost at Liberty Bancard
- Estimated monthly and annual savings
- A recommendation (interchange-plus, cash discount, or dual pricing depending on your business)

The analysis takes 24 hours after we receive your statement. It is completely free and requires no commitment.`,
  },
  {
    title: "What is interchange and why can't I change it?",
    body: `Interchange is the base cost of every card transaction — it's set by Visa, Mastercard, Discover, and Amex, not by your processor. Every processor in the country pays the same interchange rate for the same card type.

Examples (approximate):
- Visa consumer debit card: 0.05% + $0.21
- Visa consumer credit card: 1.51% + $0.10
- Visa Signature Rewards card: 2.10% + $0.10
- Mastercard World Elite: 2.20% + $0.10

Because interchange is fixed, what you negotiate with a processor is only their markup on top of interchange. That markup is 100% processor margin and is fully negotiable.

On a tiered or flat-rate pricing plan, the processor blends interchange and their markup together into a single rate — which is why most merchants never know what they're actually paying their processor.

Interchange-plus pricing (what Liberty Bancard uses) shows you both numbers separately.`,
  },
  {
    title: "What is interchange-plus pricing?",
    body: `Interchange-plus (sometimes called "cost-plus" or "pass-through" pricing) is a pricing model where you pay:
1. The exact interchange rate set by Visa/Mastercard/etc., which passes through at cost
2. A fixed markup added by the processor (e.g., 0.15% + $0.10 per transaction)

This is the most transparent pricing model in the industry.

Example: A Visa consumer credit card has an interchange rate of 1.51% + $0.10. Under interchange-plus at 0.15% + $0.10, your total cost for that transaction is 1.66% + $0.20.

Contrast with flat-rate pricing (e.g., 2.9% + $0.30 at Stripe/Square): you pay the same rate regardless of card type, which means you overpay significantly on cheaper debit cards and the processor pockets the difference.

Why it matters: Most businesses on legacy flat-rate or tiered plans are paying 0.3–0.8% more than necessary. On $100,000/month, that's $300–$800 going to the processor that should stay with you.`,
  },
  {
    title: "What is a cash discount program?",
    body: `A cash discount program lets you advertise a "cash price" and a slightly higher "card price" for your goods and services.

How it works:
- You post your normal prices as the cash price.
- When a customer pays by card, a small service fee (typically 3–4%) is added at checkout.
- The service fee covers your entire processing cost — so card transactions are essentially free to you.
- Cash-paying customers pay the posted price with no addition.

This is different from a surcharge program (which adds a fee only for credit cards). Cash discount programs are legal in all 50 states when implemented correctly.

Who it works best for: businesses with price flexibility and a mix of cash and card customers — restaurants, auto repair shops, salons, convenience stores, service businesses.

Liberty Bancard implements cash discount programs in full compliance with Visa, Mastercard, and state regulations. We provide the disclosure signage and POS configuration required.`,
  },
  {
    title: "What is a surcharge program?",
    body: `A credit card surcharge program allows merchants to add a fee — up to 3% — specifically to credit card transactions. Unlike cash discount, surcharges do not apply to debit card transactions.

Key rules:
- Surcharges are allowed on credit cards only. Never on debit or prepaid cards.
- Maximum surcharge: 3% of the transaction amount (as of current card brand rules).
- Required disclosures: signage at the store entrance and point of sale; disclosure on receipts.
- Processors must be notified 30 days before implementing a surcharge program.
- State restrictions apply: Connecticut and Massachusetts currently prohibit credit card surcharging. Puerto Rico also has restrictions.

Liberty Bancard handles all the compliance setup for surcharge programs, including disclosure materials, terminal programming, and processor notification.`,
  },
  {
    title: "How long does approval take?",
    body: `Most merchant accounts are approved within 1–2 business days of submitting a complete application.

What speeds up approval:
- Complete application with no missing fields
- Voided check or bank letter for deposit account verification
- Valid EIN (or SSN for sole proprietors)
- Clean processing history (no excessive chargebacks)

What can slow approval:
- Missing documents
- High-risk business categories (adult, firearms, pharmaceuticals, high-value collectibles)
- Chargeback history above 1% in the past 12 months
- New business with no processing history (may require additional review)

For most standard retail, restaurant, and service businesses, the process is: application submitted → underwriting review (same day or next business day) → approval email with MID → terminal ships within 1–2 business days → first transactions within the week.`,
  },
  {
    title: "What is PCI compliance and do I need to worry about it?",
    body: `PCI DSS (Payment Card Industry Data Security Standard) is a set of security requirements for any business that accepts card payments. It applies to every merchant — regardless of size.

What PCI compliance means in practice:
- Your terminals and payment software must be on the approved PCI-compliant hardware/software list.
- You must complete an annual Self-Assessment Questionnaire (SAQ) — usually SAQ B or SAQ B-IP for small merchants using terminals.
- You must not store full card numbers, CVV codes, or PINs.
- Your network must meet basic security requirements.

Liberty Bancard provides:
- PCI-compliant terminals (EMV, NFC/contactless)
- Guided SAQ completion support
- P2PE (point-to-point encryption) terminals that significantly reduce your PCI scope

Most small merchants with compliant terminals qualify for the simplest SAQ type. The annual process takes about 20–30 minutes.

Note: non-compliance fees charged by some processors ($15–$30/month) go away when you complete your SAQ. Liberty Bancard does not charge non-compliance fees while you are in the guided completion process.`,
  },
  {
    title: "Are there any contracts or early termination fees?",
    body: `Liberty Bancard offers flexible contract terms. We do not require long-term contracts for most standard merchant accounts.

Month-to-month accounts: available for most businesses. No early termination fee. You can close your account at any time with 30 days notice.

Equipment: if you received a free terminal as part of your account setup, the terminal is yours to keep after 12 months of active processing. Early cancellation within 12 months may require return of leased equipment or a nominal equipment fee — this will be disclosed in your merchant agreement before you sign.

If you are currently in a contract with another processor: we can often help cover early termination fees (ETF) up to $500 depending on your volume and savings potential. Your account manager will review your contract and advise before you make any switch.

The specifics of your agreement will always be disclosed in writing before you are asked to sign anything.`,
  },
  {
    title: "What equipment options are available?",
    body: `Liberty Bancard offers a range of payment terminals and POS hardware. Equipment is provided free with qualifying accounts — there is no upfront cost for standard terminal placement.

Terminal options:
- Countertop terminal (EMV + NFC/tap-to-pay): standard for most retail and service businesses
- Wireless/mobile terminal: for food trucks, farmers markets, trade shows, field service
- Clover POS systems: full POS with inventory, employee management, and reporting
- Toast (restaurant): GHL does not have a native integration, but we work with Toast-integrated accounts
- Virtual terminal: for phone orders and keyed-entry payments — no hardware required
- Payment links: for invoice-based businesses — customers pay via email or text link

Most terminals support:
- EMV chip cards
- Tap-to-pay (Visa, Mastercard, Amex, Google Pay, Apple Pay)
- Tip on screen
- Cash discount / dual pricing programs

Specific availability depends on your business type and processing volume. Your account manager will recommend the right equipment configuration before setup.`,
  },
  {
    title: "How does the Merchant Portal work?",
    body: `Every Liberty Bancard merchant gets access to the self-service Merchant Portal after approval.

What you can do in the portal:
- View real-time transaction data and settlement reports
- Download monthly statements (PDF)
- Manage dispute and chargeback responses
- Update banking information for deposits
- View and download 1099-K forms
- Manage users (add staff with limited access)
- Submit support tickets

Portal access is provided by email after your account is approved. The email will include a link to set your password. Your Merchant ID (MID) is required to log in.

First login: check the email from Liberty Bancard titled "Your account is approved — portal access." It arrives within minutes of approval.

Support: if you cannot log in, call (888) 555-0100 or email support@libertybancard.com.`,
  },
  {
    title: "What happens after I sign up?",
    body: `Here is the step-by-step from application to first transaction:

1. Application submitted (5–10 minutes)
   - You'll receive an immediate confirmation email.

2. Underwriting review (same day or next business day)
   - We verify your business, banking information, and processing history.
   - Approval email arrives with your Merchant ID (MID).

3. Equipment setup (1–2 business days after approval)
   - If using a physical terminal: it ships within 1–2 business days. Setup guide included.
   - If using a payment gateway: credentials are emailed. We schedule an integration call.

4. First transaction (typically within the first week)
   - Your terminal or gateway is active. Run a test transaction.
   - Funds settle to your bank account next business day.

5. First statement (30 days after activation)
   - A detailed PDF statement arrives by email showing volume, fee breakdown, and effective rate.
   - Your account manager reviews it with you to confirm everything is as expected.

Questions at any point: call (888) 555-0100 or reply to any email you receive from us.`,
  },
  {
    title: "What processing volume do I need to qualify?",
    body: `There is no minimum monthly volume required to apply for a Liberty Bancard merchant account.

However, volume does affect the value of switching:

Low volume ($0–$5,000/month): the savings from switching may be modest. We'll run the analysis honestly — if the numbers don't make sense for you, we'll tell you.

Mid volume ($5,000–$30,000/month): typically where interchange-plus starts showing clear savings over flat-rate processors. Most merchants in this range save $50–$300/month.

Higher volume ($30,000+/month): the savings compound. A 0.4% rate reduction on $50,000/month is $200/month, $2,400/year. On $200,000/month, that's $800/month.

Very high volume ($500,000+/month): custom pricing and dedicated relationship manager. Volume discounts on processor markup apply.

New businesses with no history: approved on a standard plan with a lower monthly volume cap initially. The cap increases automatically after 3–6 months of good standing.`,
  },
  {
    title: "How do next-day deposits work?",
    body: `Liberty Bancard offers next-business-day funding for most approved merchant accounts.

How it works:
- Transactions batched and settled by 10 PM ET are deposited to your bank account the next business day.
- Weekday transactions settle on the next business day. Weekend batches may settle Monday or Tuesday depending on your bank.
- ACH deposits (standard): funds arrive by 5 PM on the next business day.
- Same-day funding: available for some business types at an additional fee — ask your account manager.

What can delay funding:
- Risk holds: new accounts may have a 3–5 business day hold on the first few batches while the risk model calibrates.
- Rolling reserve: some higher-risk business types have a percentage of volume held in reserve (disclosed at approval).
- Large transactions: transactions above your approved high-ticket threshold may require manual review.

Most standard businesses (retail, restaurant, service) on good standing receive next-business-day deposits without interruption.`,
  },
  {
    title: "What are chargebacks and how do I handle them?",
    body: `A chargeback is when a cardholder disputes a transaction with their bank and the bank initiates a reversal. You have the opportunity to respond with evidence.

Common chargeback reasons:
- "I didn't authorize this transaction" (fraud)
- "I cancelled and was still charged" (subscription/service merchants)
- "Services/goods not as described"
- "I returned the item but wasn't refunded"
- "I don't recognize this charge" (friendly fraud — the most common)

How to respond:
1. You receive a chargeback notification by email with a response deadline (typically 7–21 days).
2. Log into the Merchant Portal → Disputes tab.
3. Upload evidence: receipts, signed agreements, delivery confirmation, communication logs.
4. Submit before the deadline.

Winning rate: merchants who respond with complete documentation win approximately 40–60% of representment cases.

Prevention: clear business name on statements, clear cancellation policies, confirmation emails, signed agreements for services — these all reduce "I didn't recognize it" disputes.

Liberty Bancard's chargeback ratio threshold: 1% of transactions. Accounts above 1% may receive a warning. Above 1.5% triggers a mandatory review.`,
  },
  {
    title: "Does Liberty Bancard integrate with my POS or software?",
    body: `Liberty Bancard integrates with most major POS systems, restaurant platforms, and business software.

Confirmed integrations:
- Clover (native — we are a Clover reseller)
- Square (migration path — we can port your data)
- Toast (via payment gateway integration)
- Heartland, TSYS, First Data accounts (migration support)
- QuickBooks (via virtual terminal or gateway)
- WooCommerce, Shopify (payment gateway)
- Most NMI-compatible platforms

For specialty software (dental, veterinary, property management, etc.):
- We verify compatibility before you commit to anything.
- If your software supports a third-party payment gateway, we can almost always integrate.

How to check your specific system: tell your account manager what software you use. They will confirm compatibility within 1 business day.

Note: switching processors rarely requires changing your POS software. In most cases, we reprogram your existing terminal or add a new gateway credential without touching your other systems.`,
  },
];

const HANDOFF_TRIGGERS = [
  { category: "Explicit Human Request", phrases: [
    "speak to a person",
    "talk to someone",
    "real person",
    "actual person",
    "live person",
    "human agent",
    "real agent",
    "talk to a human",
    "get me a rep",
    "connect me to someone",
    "transfer me",
    "I want to talk to Scott",
    "stop the bot",
    "not a bot",
    "is this a real person",
    "am I talking to a person",
  ]},
  { category: "Angry / Frustrated Intent", phrases: [
    "this is ridiculous",
    "this is a waste of my time",
    "you're useless",
    "scam",
    "rip-off",
    "I'll sue",
    "attorney general",
    "Better Business Bureau",
    "worst company",
    "cancel everything",
    "done with you",
    "I'm going to report you",
  ]},
  { category: "Complex Pricing / Negotiation", phrases: [
    "what are your exact rates",
    "give me your rate sheet",
    "I want to negotiate",
    "beat my current rate",
    "match what I'm paying",
    "basis points",
    "interchange plus plus",
    "flat rate comparison",
    "batch fee",
    "PCI non-compliance fee",
    "early termination fee",
    "what's in the contract",
  ]},
  { category: "Ready to Apply / Sign", phrases: [
    "I want to sign up",
    "let's do it",
    "send me the application",
    "where do I apply",
    "I'm ready",
    "how do I get started",
    "I want to switch",
    "sign me up",
  ]},
  { category: "Low Confidence / Confusion", phrases: [
    "I don't understand",
    "that doesn't make sense",
    "you're not answering my question",
    "you already said that",
    "I'm going in circles",
    "this is confusing",
    "what do you mean",
    "can you explain that again",
  ]},
];

const VERTICAL_OVERRIDES = [
  {
    name: "Restaurant",
    icon: "🍽️",
    color: "border-orange-500",
    opening: "Hi [name], this is Alex with Liberty Bancard — we work with a lot of restaurants in [city] and I wanted to reach out about your processing costs. Tip adjustments and POS integration are usually the big ones for restaurants. Do you have a quick minute?",
    tone: "Casual and direct. Restaurants are busy — respect their time. Lead with POS system compatibility and tip workflow.",
    painPoints: [
      "Tip adjustment fees and card brand compliance — many restaurants use a non-compliant tip workflow and don't know it.",
      "POS integration: Toast, Square, Clover. Many restaurant owners don't know they can keep their POS and switch processors.",
      "High debit card volume from lunch customers — surcharge or cash discount programs significantly reduce cost.",
      "Online ordering transaction fees compound quickly — 2.6% on $50 delivery orders adds up fast.",
    ],
    offerPaths: "Cash Discount or Dual Pricing first. Interchange-plus as fallback.",
  },
  {
    name: "Med Spa",
    icon: "💆",
    color: "border-pink-500",
    opening: "Hi [name], Alex with Liberty Bancard — we work with a number of med spas and aesthetics practices, and the processing costs in your space tend to be higher than they should be because of the luxury card types your clients use. Is now a good time for 60 seconds?",
    tone: "Professional and numbers-focused. Med spa owners are sophisticated — lead with the financial case, not features.",
    painPoints: [
      "Luxury card types (Amex Platinum, Visa Infinite, World Elite) dominate med spa clientele and carry premium interchange — tiered processors bury this.",
      "High average tickets ($200–$800) mean even 0.2% overpayment is $400–$1,600/month at typical volumes.",
      "Chargebacks from disputed cosmetic results — documentation and consent form workflows matter.",
      "Tip adjustments on service bills must be card-brand compliant — non-compliant workflow is a chargeback risk.",
    ],
    offerPaths: "Dual Pricing or Interchange-Plus. Mention Amex OptBlue for practices processing significant Amex volume.",
  },
  {
    name: "Dental",
    icon: "🦷",
    color: "border-blue-500",
    opening: "Hi [name], Alex from Liberty Bancard — we work with dental practices and there's a specific issue we see a lot in your space: practices paying retail interchange rates when they should be qualifying for standard rates. Takes us about 24 hours to check. Is that worth a look?",
    tone: "Clinical and precise. Dentists respond to specific, data-driven arguments. Mention practice management software compatibility early.",
    painPoints: [
      "Dental-specific processors charge a premium for the vertical branding — underlying interchange is identical to any other processor.",
      "High average tickets ($500–$5,000 procedures) amplify the cost of high effective rates.",
      "Many dental offices unknowingly key-enter transactions (card-not-present) and pay higher interchange as a result.",
      "In-house payment plans and stored credentials require proper authorization documentation to prevent chargebacks.",
    ],
    offerPaths: "Interchange-Plus primary. Mention P2PE terminals to reduce PCI scope.",
  },
  {
    name: "Auto Repair",
    icon: "🔧",
    color: "border-slate-500",
    opening: "Hi [name], Alex with Liberty Bancard — we work with auto shops and the cash discount program tends to be a big hit in your space. A lot of your customers pay cash anyway, and the ones who pay card — you'd basically process for free. Got 60 seconds?",
    tone: "Practical and cash-focused. Auto repair owners are pragmatic — lead with the cash discount framing. Mention coverage of early termination fees if they're locked in.",
    painPoints: [
      "Variable ticket sizes ($80 oil change to $3,000 transmission) make flat-rate pricing expensive on large jobs.",
      "Customers dispute charges when repairs exceed the estimate — 'unauthorized amount' chargebacks are common. Clear written estimates help.",
      "Debit-heavy customer base makes cash discount programs ideal — customers are used to cash and respond well to the discount.",
      "Fleet cards (WEX, Voyager) require separate acceptance — do not promise fleet card acceptance without verifying underwriting.",
    ],
    offerPaths: "Cash Discount first. Interchange-Plus fallback. Flag fleet card acceptance for separate underwriting review.",
  },
  {
    name: "Salon",
    icon: "✂️",
    color: "border-purple-500",
    opening: "Hi [name], Alex from Liberty Bancard — most salons on Square are paying 2.6% plus 10 cents per transaction. Depending on your volume, interchange-plus typically runs about a third less. We'd show you the comparison before you commit to anything. Worth 2 minutes?",
    tone: "Lead with the Square comparison — it's concrete and relatable. Tip-on-screen feature parity is important to mention early.",
    painPoints: [
      "Square is dominant in this space at 2.6%+ — many salon owners don't realize the markup gap.",
      "Tip on screen: our terminals support the same tip-on-screen experience as Square — zero disruption to checkout flow.",
      "Booth rental complexity: booth renters are separate legal entities. Do not co-mingle MIDs.",
      "Stored credentials for no-show fee enforcement requires written cardholder consent — this is a common compliance gap.",
    ],
    offerPaths: "Cash Discount or Interchange-Plus. Mention stored credential support for no-show fee programs.",
  },
  {
    name: "Gym",
    icon: "🏋️",
    color: "border-green-500",
    opening: "Hi [name], Alex with Liberty Bancard — we work with gyms and one thing that usually surprises owners is how much they can save by moving monthly dues to ACH instead of cards. We're talking $0.25 per transaction versus 2.5%. Is that worth exploring?",
    tone: "Lead with the ACH angle for recurring dues — it's the highest-impact switch for gyms. Address the chargeback concern head-on.",
    painPoints: [
      "Recurring membership billing on cards costs 2–2.5%/transaction. ACH costs $0.25–$0.50 flat — massive savings at scale.",
      "Chargeback risk from 'I cancelled and was still charged' — this is a documentation issue, not a processor issue. We advise on cancellation workflows.",
      "Some gym software (Mindbody, ABC Fitness) resells processing at a markup — merchants can often keep the software and switch processors.",
      "January volume spikes are normal in this vertical — our underwriting team accounts for seasonal patterns explicitly.",
    ],
    offerPaths: "ACH for recurring dues + Interchange-Plus for retail/day passes. Note that gyms are a moderate-risk vertical — rolling reserve may apply.",
  },
];

const TEST_SCRIPT = [
  { turn: 1, speaker: "Tester", msg: "Hello?" },
  { turn: 2, speaker: "Alex (expected)", msg: "Hi — this is Alex with Liberty Bancard. Is this [name]? [wait for response] Great — I'm calling about the request you submitted on our website. Do you have a quick minute?" },
  { turn: 3, speaker: "Tester", msg: "Yes, but I'm not sure what this is about. I just filled out a form." },
  { turn: 4, speaker: "Alex (expected)", msg: "Totally — you submitted a request about your merchant processing costs. We do a free review of your statement that shows exactly what you're paying your processor versus what you should be paying. The analysis takes about 24 hours and there's no cost or commitment. Does that sound like something you'd want to see?" },
  { turn: 5, speaker: "Tester", msg: "I'm pretty happy with my current rates. I use Square." },
  { turn: 6, speaker: "Alex (expected)", msg: "Square works well — they're at 2.6% plus 10 cents on card-present. Most merchants in your range are at meaningfully lower rates on interchange-plus. I can't give you a specific number without the statement, but if you send it over we'll show you side-by-side. It's genuinely free — no sales pitch until you've seen the numbers." },
  { turn: 7, speaker: "Tester", msg: "Are you a real person or is this a robot?" },
  { turn: 8, speaker: "Alex (expected)", msg: "I'm Alex, Liberty Bancard's AI assistant. I can answer most questions right now — or I can connect you with Scott directly if you prefer a person. Which would you like?" },
  { turn: 9, speaker: "Tester", msg: "Okay, how much can I save?" },
  { turn: 10, speaker: "Alex (expected)", msg: "I can't give you a number without your statement — every business is different. What I can tell you is our average analysis shows merchants are overpaying by 0.3 to 0.8 percent on their volume. On $50,000 a month, that's $150 to $400. The only way to know your number is to send the statement. Takes 24 hours and it's free. Want me to send the upload link right now?" },
  { turn: 11, speaker: "Tester — HANDOFF TEST", msg: "I want to speak to a real person right now." },
  { turn: 12, speaker: "Alex (expected)", msg: "Of course — let me connect you with Scott directly. One moment." },
];

const GOLIVE_CHECKLIST_ITEMS = [
  "Identity test passed — AI introduces itself as 'Alex, Liberty Bancard's AI assistant' (NOT 'ChatGPT', NOT 'an AI language model', NOT 'OpenAI')",
  "Voice AI tested — call the GHL number, go through all 6 call modes (intro_qualification, cold_outbound, follow_up_callback, statement_chase, proposal_followup, onboarding_assist)",
  "SMS AI tested — send 'I want to lower my processing fees' and verify AI responds with an offer to review statement, not a generic reply",
  "Handoff test passed — say 'I want to speak to a real person' and verify transfer fires correctly in both Voice and SMS channels",
  "Calendar booking test passed — say 'I want to book a call' during a Voice AI session and verify calendar link or GHL calendar widget fires",
  "Knowledge Base attached — GHL → AI Employee → SMS channel → Knowledge Base → confirm all 15 FAQ articles are attached and active",
  "Recording enabled — GHL → Settings → AI Employee → Voice channel → Recording toggle is ON",
  "All 6 vertical bot contexts pasted — GHL → AI Employee → for each vertical sub-persona, confirm the opening line and tone notes are in the persona configuration",
  "Human handoff triggers configured — GHL → AI Employee → Handoff Triggers → all 5 categories of phrases entered (explicit request, angry, complex pricing, ready to apply, low confidence)",
  "Compliance footer verified — first SMS in any conversation includes 'Reply STOP to opt out'",
  "Business hours enforced — Voice AI set to Mon–Fri 9 AM–5 PM contact local timezone; no AI calls outside these hours",
  "Go live — flip AI Employee status to Active in GHL Settings → AI Employee for both Voice and SMS channels",
];

function VerticalCard({ v, index }: { v: typeof VERTICAL_OVERRIDES[0]; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={`border-l-4 ${v.color}`}>
      <button
        className="w-full flex items-start justify-between gap-3 p-4 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setOpen(!open)}
        data-testid={`btn-vertical-${index}`}
        aria-label={`Toggle ${v.name} vertical details`}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{v.icon}</span>
          <div>
            <p className="text-sm font-semibold">{v.name}</p>
            <p className="text-xs text-muted-foreground">Opening line · Tone · Pain points · Offer path</p>
          </div>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-1" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />}
      </button>
      {open && (
        <CardContent className="pt-0 pb-4 space-y-3 border-t">
          <div className="pt-3">
            <CopyBlock label="Opening Line — paste as vertical persona intro" text={v.opening} />
          </div>
          <div className="p-3 rounded-md bg-muted/40 border">
            <p className="text-xs font-semibold mb-1">Tone Guidance</p>
            <p className="text-xs text-muted-foreground">{v.tone}</p>
          </div>
          <div>
            <p className="text-xs font-semibold mb-2 uppercase tracking-wide text-muted-foreground">Vertical Pain Points (for Knowledge Base / AI context)</p>
            <ul className="space-y-1.5">
              {v.painPoints.map((pt, pi) => (
                <li key={pi} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <ArrowRight className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/60" /> {pt}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex gap-2 p-3 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
            <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-0.5">Recommended Offer Path</p>
              <p className="text-xs text-emerald-700 dark:text-emerald-400">{v.offerPaths}</p>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function KbArticle({ article, index }: { article: typeof KB_ARTICLES[0]; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button
        className="w-full flex items-start justify-between gap-3 p-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setOpen(!open)}
        data-testid={`btn-kb-${index}`}
        aria-label={`Toggle KB article: ${article.title}`}
      >
        <div className="flex items-start gap-2.5">
          <span className="flex items-center justify-center h-5 w-5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 text-xs font-bold shrink-0 mt-0.5">{index + 1}</span>
          <p className="text-xs font-medium leading-relaxed">{article.title}</p>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />}
      </button>
      {open && (
        <CardContent className="pt-0 pb-3 border-t">
          <div className="pt-3">
            <CopyBlock label={`KB Article ${index + 1} — paste as GHL Knowledge Base article body`} text={`${article.title}\n\n${article.body}`} />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function AiEmployeeTab() {
  const [goLiveChecked, setGoLiveChecked] = useState<Record<number, boolean>>({});
  const doneLive = Object.values(goLiveChecked).filter(Boolean).length;

  return (
    <div className="space-y-6">
      {/* Overview callout */}
      <div className="flex gap-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/20">
        <Bot className="h-5 w-5 text-violet-600 dark:text-violet-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold text-violet-700 dark:text-violet-300 mb-1">What this tab is for</p>
          <p className="text-violet-700 dark:text-violet-400">
            Everything you need to build, configure, and test GHL's Voice AI and SMS AI Employees in a single session.
            Copy each prompt, paste it into GHL, configure the settings listed, run the test script, check off the go-live list.
          </p>
        </div>
      </div>

      {/* ── VOICE AI ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Phone className="h-5 w-5 text-violet-500" /> Voice AI Employee — "Alex"
          </CardTitle>
          <CardDescription>
            GHL → Settings → AI Employee → + New → Phone channel. Name: <strong>Liberty Bancard AI — Voice</strong>.
            Paste the system prompt below into the "System Prompt" or "Instructions" field.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyBlock label="Voice AI System Prompt — paste into GHL AI Employee (Phone channel)" text={VOICE_AI_SYSTEM_PROMPT} />

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">GHL Setup Steps — Voice AI Employee</p>
            {[
              { step: "1", text: "GHL → Settings → AI Employee → + Create New → select Phone channel" },
              { step: "2", text: "Name: 'Liberty Bancard AI — Voice'. Display name: 'Alex'" },
              { step: "3", text: "Paste the system prompt above into the Instructions / System Prompt field" },
              { step: "4", text: "Business Hours: Mon–Fri 9 AM – 5 PM. Timezone: Contact's local timezone (GHL auto-detects this)" },
              { step: "5", text: "Connect GHL Calendar: Settings → Calendar → select your booking calendar. This enables Alex to book appointments live on the call." },
              { step: "6", text: "Handoff Triggers: enter all phrases from the Handoff Triggers section below (all 5 categories)" },
              { step: "7", text: "Recording: toggle ON. Required for compliance review and sales coaching." },
              { step: "8", text: "Call Modes (Personas): if GHL supports multiple personas, create one per call mode listed in the prompt (intro_qualification, cold_outbound, follow_up_callback, statement_chase, proposal_followup, onboarding_assist). Otherwise, the single prompt handles all modes via the CALL MODES section." },
              { step: "9", text: "Test: call your GHL number → verify Alex introduces itself as 'Alex, Liberty Bancard's AI assistant' — NOT 'ChatGPT' or 'an AI language model'" },
            ].map(({ step, text }) => (
              <div key={step} className="flex items-start gap-2.5 text-xs">
                <span className="flex items-center justify-center h-5 w-5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-bold shrink-0 mt-0.5 text-[10px]">{step}</span>
                <span className="text-muted-foreground">{text}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── SMS AI ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-green-500" /> SMS AI Employee — "Alex"
          </CardTitle>
          <CardDescription>
            GHL → Settings → AI Employee → + New → SMS/Text channel. Name: <strong>Liberty Bancard AI — SMS</strong>.
            Paste the prompt below. Keep all AI SMS replies under 160 characters — configure max response length in GHL.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
            <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-700 dark:text-amber-400">
              <strong>SMS character limit:</strong> One SMS segment = 160 characters. Two segments = 320 characters. Configure GHL's SMS AI to keep responses under 160 characters wherever possible. Long AI replies feel spammy and reduce reply rates. The prompt instructs Alex accordingly, but verify in testing.
            </div>
          </div>
          <CopyBlock label="SMS AI System Prompt — paste into GHL AI Employee (SMS/Text channel)" text={SMS_AI_SYSTEM_PROMPT} />

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">GHL Setup Steps — SMS AI Employee</p>
            {[
              { step: "1", text: "GHL → Settings → AI Employee → + Create New → select SMS/Text channel" },
              { step: "2", text: "Name: 'Liberty Bancard AI — SMS'. Display name: 'Alex'" },
              { step: "3", text: "Paste the SMS system prompt above into the Instructions field" },
              { step: "4", text: "Max Response Length: set to 'Short' or configure 160 character limit if the option is available" },
              { step: "5", text: "Handoff Triggers: same phrases as Voice AI (Handoff Triggers section below)" },
              { step: "6", text: "Knowledge Base: click 'Attach Knowledge Base' → select your Liberty Bancard KB → attach all 15 FAQ articles from the Knowledge Base section below" },
              { step: "7", text: "Calendar: connect your GHL calendar so Alex can send booking links inline during SMS conversations" },
              { step: "8", text: "Activate on Workflow 1, Step 9 only (Day 3 AI Conversation). Do not activate earlier in the sequence — let the human rep handle the first 2 days." },
              { step: "9", text: "Test: send a test SMS 'How much can I save on credit card fees?' → verify Alex responds with the correct savings framing and does NOT quote a specific rate" },
            ].map(({ step, text }) => (
              <div key={step} className="flex items-start gap-2.5 text-xs">
                <span className="flex items-center justify-center h-5 w-5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 font-bold shrink-0 mt-0.5 text-[10px]">{step}</span>
                <span className="text-muted-foreground">{text}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── KNOWLEDGE BASE ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-blue-500" /> Knowledge Base Articles (15)
          </CardTitle>
          <CardDescription>
            GHL → Documents (or Knowledge Base) → + New Document. Create one article per item below.
            Attach the completed Knowledge Base to your SMS AI Employee.
            Each article should be pasted as a separate document with the title as the document name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {KB_ARTICLES.map((article, i) => (
              <KbArticle key={i} article={article} index={i} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── HANDOFF TRIGGERS ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-5 w-5 text-red-500" /> Handoff Trigger Phrases
          </CardTitle>
          <CardDescription>
            GHL → Settings → AI Employee → (select your AI employee) → Handoff Triggers.
            Enter each phrase below exactly as written. GHL matches on partial phrases — enter the key words, not the full sentence.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {HANDOFF_TRIGGERS.map((cat, ci) => (
              <div key={ci}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline" className="text-xs">{cat.category}</Badge>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <tbody>
                      {cat.phrases.map((phrase, pi) => (
                        <tr key={pi} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="py-1.5 pr-3 font-mono text-muted-foreground">{phrase}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2">
                  <CopyBlock
                    label={`${cat.category} — copy all phrases`}
                    text={cat.phrases.join("\n")}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── VERTICAL BOT CONTEXTS ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Tag className="h-5 w-5 text-fuchsia-500" /> Vertical Bot Contexts
          </CardTitle>
          <CardDescription>
            One collapsible section per vertical. Each contains the opening line to paste into GHL as a vertical-specific
            persona or sub-workflow intro, the tone guidance, vertical-specific pain points for the Knowledge Base, and the recommended offer path.
            In GHL, create a separate AI persona or workflow branch per vertical, or add a routing If/Else before the AI action.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {VERTICAL_OVERRIDES.map((v, i) => (
              <VerticalCard key={i} v={v} index={i} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── TEST SCRIPT ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-teal-500" /> 10-Message Test Script
          </CardTitle>
          <CardDescription>
            Run this conversation against the Voice AI (or SMS AI) before going live. Each line is what the tester says and what Alex should respond.
            The test covers: intro, objection handling, identity disclosure, no-guarantee policy, and human handoff.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {TEST_SCRIPT.map((turn) => {
              const isAlex = turn.speaker.startsWith("Alex");
              const isHandoff = turn.speaker.includes("HANDOFF");
              return (
                <div
                  key={turn.turn}
                  className={`rounded-md p-3 text-xs border ${
                    isHandoff
                      ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
                      : isAlex
                      ? "bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800"
                      : "bg-muted/40 border-muted"
                  }`}
                >
                  <p className={`font-semibold mb-0.5 ${isHandoff ? "text-red-600 dark:text-red-400" : isAlex ? "text-violet-700 dark:text-violet-300" : "text-muted-foreground"}`}>
                    Turn {turn.turn} — {turn.speaker}
                  </p>
                  <p className={isAlex ? "text-violet-700 dark:text-violet-400" : "text-foreground"}>
                    {turn.msg}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex gap-3 p-3 rounded-md border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-900/20">
            <Info className="h-4 w-4 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />
            <p className="text-xs text-teal-700 dark:text-teal-400">
              <strong>What to verify:</strong> Turn 2 uses the Liberty Bancard name (not ChatGPT). Turn 8 identifies as AI correctly. Turn 10 does not quote a specific savings number. Turn 12 fires the handoff and does not continue the conversation.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── GO-LIVE CHECKLIST ─────────────────────────────────── */}
      <Card className="border-2 border-emerald-300 dark:border-emerald-700">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Go-Live Checklist
            </span>
            <Badge variant="secondary">{doneLive}/{GOLIVE_CHECKLIST_ITEMS.length} done</Badge>
          </CardTitle>
          <CardDescription>
            Do not flip the AI Employee to Active until every item below is checked. These are the minimum verifications required before going live.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5">
            {GOLIVE_CHECKLIST_ITEMS.map((item, i) => (
              <li
                key={i}
                className="flex items-start gap-2.5 cursor-pointer"
                onClick={() => setGoLiveChecked(prev => ({ ...prev, [i]: !prev[i] }))}
                data-testid={`check-golive-${i}`}
              >
                <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors ${goLiveChecked[i] ? "bg-emerald-500 border-emerald-500" : "border-muted-foreground/40"}`}>
                  {goLiveChecked[i] && <CheckCircle2 className="h-3 w-3 text-white" />}
                </div>
                <span className={`text-xs leading-relaxed ${goLiveChecked[i] ? "line-through text-muted-foreground" : ""}`}>{item}</span>
              </li>
            ))}
          </ul>
          {doneLive === GOLIVE_CHECKLIST_ITEMS.length && (
            <div className="mt-4 flex gap-3 p-3 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">All checks passed — your AI Employee is ready to go live.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function GhlSequenceGuide() {
  const [globalCheck, setGlobalCheck] = useState<Record<string, boolean>>({});

  function toggleGlobal(key: string) {
    setGlobalCheck(prev => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">GHL Workflow Build Guide</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The complete customer journey — 9 workflows covering prospecting, qualifying, closing, onboarding, go-live, retention, and win-back.
            This is a reference design for the GHL side. Replit owns cadence and execution; sequence workflow IDs are reference-only (IDs for supported handoff workflows are separate and are used at enrollment).
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button asChild variant="outline" size="sm" data-testid="btn-ghl-manager-link">
            <Link href="/dashboard/ghl-workflows">
              <Settings className="h-4 w-4 mr-1.5" /> GHL Workflow IDs
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" data-testid="btn-ghl-external">
            <a href="https://app.gohighlevel.com" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-1.5" /> Open GHL
            </a>
          </Button>
        </div>
      </div>

      <GhlOwnershipNotice reference testId="notice-ghl-ownership-guide" />

      {/* Architecture callout */}
      <div className="flex gap-3 p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
        <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <span className="font-semibold text-blue-700 dark:text-blue-300">How it works: </span>
          <span className="text-blue-700 dark:text-blue-400">
            This platform detects qualifying events (form submission, stage change, tag added) and decides eligibility through its own sequence engine. Replit owns the cadence, timing, branching, suppression and sender policy; the workflow designs below are reference material, not an execution handoff to GHL.
          </span>
        </div>
      </div>

      {/* Flow diagram */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4" /> How Leads Move Through the System
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Acquisition → Closing</p>
            <div className="flex items-center gap-1 flex-wrap text-xs">
              {[
                { label: "New Lead", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
                { label: "→ WF1 Inbound / WF2 Cold Outbound", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
                { label: "→ Reply → WF3", color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
                { label: "→ Statement → WF4", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" },
                { label: "→ Proposal → WF5", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
                { label: "→ Closed Won", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
              ].map((node, i) => (
                <span key={i} className={`px-2 py-1 rounded-md font-medium ${node.color}`}>{node.label}</span>
              ))}
            </div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1 mt-3">Onboarding → Retention → Win-Back</p>
            <div className="flex items-center gap-1 flex-wrap text-xs">
              {[
                { label: "Closed Won", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
                { label: "→ WF6 Welcome & App", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300" },
                { label: "→ WF7 Approval & Go-Live", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300" },
                { label: "→ WF8 Retention & NPS", color: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300" },
                { label: "Churned? → WF9 Win-Back", color: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300" },
                { label: "Re-engagement at 60/90/120 days", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
              ].map((node, i) => (
                <span key={i} className={`px-2 py-1 rounded-md font-medium ${node.color}`}>{node.label}</span>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main tabs */}
      <Tabs defaultValue="wf1">
        <TabsList className="flex flex-wrap h-auto gap-1 mb-2">
          <TabsTrigger value="wf1" data-testid="tab-wf1">WF1 — Inbound</TabsTrigger>
          <TabsTrigger value="wf2" data-testid="tab-wf2">WF2 — Cold Outbound</TabsTrigger>
          <TabsTrigger value="wf3" data-testid="tab-wf3">WF3 — Reply Engaged</TabsTrigger>
          <TabsTrigger value="wf4" data-testid="tab-wf4">WF4 — Statement Chase</TabsTrigger>
          <TabsTrigger value="wf5" data-testid="tab-wf5">WF5 — Proposal</TabsTrigger>
          <TabsTrigger value="wf6" data-testid="tab-wf6">WF6 — Onboarding</TabsTrigger>
          <TabsTrigger value="wf7" data-testid="tab-wf7">WF7 — Go-Live</TabsTrigger>
          <TabsTrigger value="wf8" data-testid="tab-wf8">WF8 — Retention</TabsTrigger>
          <TabsTrigger value="wf9" data-testid="tab-wf9">WF9 — Win-Back</TabsTrigger>
          <TabsTrigger value="reengage" data-testid="tab-reengage">Re-engagement</TabsTrigger>
          <TabsTrigger value="tags" data-testid="tab-tags">Tag Reference</TabsTrigger>
          <TabsTrigger value="global" data-testid="tab-global">Global Setup</TabsTrigger>
          <TabsTrigger value="admin-setup" data-testid="tab-admin-setup">GHL Admin Setup</TabsTrigger>
          <TabsTrigger value="email-library" data-testid="tab-email-library">📧 Email Library</TabsTrigger>
          <TabsTrigger value="manual-sequences" data-testid="tab-manual-sequences">📋 Manual Sequences</TabsTrigger>
          <TabsTrigger value="multi-touch" data-testid="tab-multi-touch">🔁 Multi-Touch Map</TabsTrigger>
          <TabsTrigger value="ai-employee" data-testid="tab-ai-employee">🤖 AI Employee</TabsTrigger>
          <TabsTrigger value="signatures" data-testid="tab-signatures">✍️ Signatures</TabsTrigger>
          <TabsTrigger value="workflow-guard" data-testid="tab-workflow-guard">🛡️ Workflow Guard</TabsTrigger>
        </TabsList>

        {WORKFLOWS.map(wf => (
          <TabsContent key={wf.id} value={`wf${WORKFLOWS.indexOf(wf) + 1}`} className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{wf.name}</CardTitle>
                <CardDescription className="font-mono text-xs">Trigger: Contact Tag Added = {wf.triggerTag}</CardDescription>
              </CardHeader>
              <CardContent>
                <WorkflowPanel wf={wf} />
              </CardContent>
            </Card>
          </TabsContent>
        ))}

        {/* Re-engagement Sequences */}
        <TabsContent value="reengage" className="mt-4">
          <div className="space-y-4">
            {/* Overview callout */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4 text-orange-500" />
                  Re-engagement Sequence — Cold Lead Revival
                </CardTitle>
                <CardDescription>
                  For contacts who submitted a form but never converted. Triggers at 60, 90, and 120 days of dormancy.
                  Run from the <strong>Cold Lead Re-engagement</strong> dashboard at{" "}
                  <Link href="/dashboard/cold-leads" className="underline text-primary">
                    /dashboard/cold-leads
                  </Link>.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-3 p-3 rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/20">
                  <Info className="h-4 w-4 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
                  <div className="text-sm text-orange-700 dark:text-orange-300">
                    <strong>How it works:</strong> An admin reviews the Cold Lead Re-engagement dashboard, selects dormant contacts,
                    and clicks "Re-engage." The platform applies the tag{" "}
                    <code className="text-xs bg-orange-100 dark:bg-orange-900/40 px-1 rounded">COLD-NO-DEAL</code> and enrolls the
                    contact in GHL sequence <em>"19. Reactivation — Cold Lead Revival"</em>. No automatic enrollment — v1 is manual-trigger only.
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Touchpoint 1 — Day 60 */}
            <Card className="border-l-4 border-blue-500">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-sm">Day 60 Touchpoint</CardTitle>
                  <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 gap-1 text-xs">
                    <Mail className="h-3 w-3" /> Email
                  </Badge>
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 gap-1 text-xs">
                    <MessageSquare className="h-3 w-3" /> SMS
                  </Badge>
                </div>
                <CardDescription>
                  Trigger tag: <code className="text-xs bg-muted px-1 rounded">RE-ENGAGE-60</code> — fires 60 days after
                  the original form submission date. "We updated our analysis" hook — low friction, high relevance.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <CopyBlock
                  label="Email Subject"
                  text="Still thinking about it? We updated our analysis for {{contact.companyName}}."
                />
                <CopyBlock
                  label="Email Body"
                  text={`Hi {{contact.firstName}},

A few months ago you reached out about your merchant processing. We don't know if the timing was off, or if you found another solution — but we've been running more analyses lately and wanted to share what we're seeing.

The average merchant on legacy pricing is now paying 0.45–0.90% more than the current floor. On $80,000/month, that's $360–$720 going to your processor that should stay in your pocket.

If you're still open to a quick look, all we need is one statement. Takes us 24 hours to run it.

[Statement Upload Link]

No pressure — just didn't want you to miss the window.

— Scott Allen, Liberty Bancard
📞 (888) 555-0100 | www.libertybancard.com

Eligibility, underwriting, and card brand rules apply.`}
                />
                <CopyBlock
                  label="SMS (send same day as email, 2 hrs after)"
                  text={`Hi {{contact.firstName}} — Liberty Bancard checking in. We updated our statement analysis for merchants in your area. If you want a free look at your processing costs, reply YES and I'll send the link. Reply STOP to opt out.`}
                />
                <div className="flex gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                  <Settings className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-0.5">GHL Configuration — Day 60</p>
                    <p className="text-xs text-blue-700 dark:text-blue-400">
                      Trigger: Contact Tag Added = COLD-NO-DEAL. Wait 0 days (fire immediately on enrollment — the enrollment itself happens at the 60-day mark).
                      Send Email → use branded template. Then wait 2 hours → Send SMS. Enable reply detection on both → if reply received, stop sequence and tag RE-ENGAGE-REPLIED → enroll in Workflow 3 (Reply Engaged).
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Touchpoint 2 — Day 90 */}
            <Card className="border-l-4 border-purple-500">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-sm">Day 90 Touchpoint</CardTitle>
                  <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 gap-1 text-xs">
                    <Mail className="h-3 w-3" /> Email
                  </Badge>
                </div>
                <CardDescription>
                  Trigger tag: <code className="text-xs bg-muted px-1 rounded">RE-ENGAGE-90</code> — fires 30 days after
                  Day 60. Industry-specific case study with personalization tokens. Demonstrate social proof relevant to their vertical.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <CopyBlock
                  label="Email Subject"
                  text="How a {{contact.vertical}} business saved ${{savings}}/month on processing (case study)"
                />
                <CopyBlock
                  label="Email Body (personalize with vertical before sending)"
                  text={`Hi {{contact.firstName}},

I wanted to share a quick story from one of our recent clients — I think it applies to what you're dealing with too.

They run a {{contact.vertical}} business similar to {{contact.companyName}}. Their monthly volume was around $120,000. Their processor had them on a tiered pricing plan with a 2.9% + $0.30 flat rate. Sounds fine — until we ran the statement.

What we found: the actual cost for most of their card types was 1.65% interchange + 0.40% markup. They were paying 0.85% extra on every dollar — about $1,020/month in excess fees.

We switched them to interchange-plus. First full month: $840 back in their pocket.

If you process credit cards, there's a good chance something similar is hiding in your statement. The only way to know is to look.

[Statement Upload Link] — 2 minutes to upload, 24 hours for your full breakdown.

— Scott Allen, Liberty Bancard

Eligibility, underwriting, and card brand rules apply. Individual results vary.`}
                />
                <div className="flex gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                  <Settings className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-0.5">GHL Configuration — Day 90</p>
                    <p className="text-xs text-blue-700 dark:text-blue-400">
                      Reference design (cadence is owned by Replit): after the Day 60 step completes with no reply, the Day 90 step follows 30 days later with tag RE-ENGAGE-90.
                      Personalization: use the contact's vertical field for the industry reference. If vertical is blank, use "retail" as the default.
                      Add reply detection → stop sequence → tag RE-ENGAGE-REPLIED → enroll in Workflow 3.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Touchpoint 3 — Day 120 */}
            <Card className="border-l-4 border-orange-500">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-sm">Day 120 Touchpoint</CardTitle>
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 gap-1 text-xs">
                    <MessageSquare className="h-3 w-3" /> SMS
                  </Badge>
                </div>
                <CardDescription>
                  Final touchpoint — 30 days after Day 90. New offer or seasonal hook via SMS. Short, punchy, low pressure.
                  After this, tag <code className="text-xs bg-muted px-1 rounded">RE-ENGAGE-EXHAUSTED</code> and move to long-term nurture.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <CopyBlock
                  label="SMS (seasonal variant — swap hook as needed)"
                  text={`{{contact.firstName}} — one last check-in from Liberty Bancard. End-of-year is a great time to review processing costs before the busy season hits. Free analysis, no commitment: www.libertybancard.com/upload-statement — Takes 2 min. Reply STOP to opt out.`}
                />
                <CopyBlock
                  label="Alternative SMS (non-seasonal)"
                  text={`Hi {{contact.firstName}}, Scott at Liberty Bancard. We haven't connected yet — if you ever want a free look at your processing rates, just reply YES or visit www.libertybancard.com/upload-statement. No pressure, no spam after this. Reply STOP to opt out.`}
                />
                <div className="flex gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                  <ArrowRight className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-0.5">After Day 120 — Exit Logic</p>
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      If no reply after Day 120 SMS: apply tag RE-ENGAGE-EXHAUSTED. Remove RE-ENGAGE-60 / RE-ENGAGE-90 tags.
                      Enroll in Long-Term Nurture (quarterly educational content — no hard sales pitch). Do not re-run the re-engagement sequence for at least 180 days.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                  <Settings className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-0.5">GHL Configuration — Day 120</p>
                    <p className="text-xs text-blue-700 dark:text-blue-400">
                      After Day 90 step with no reply, wait 30 days → Send SMS (use seasonal variant if Q4, otherwise non-seasonal).
                      After SMS: wait 7 days → If/Else: reply received? Yes → stop + tag RE-ENGAGE-REPLIED. No → apply RE-ENGAGE-EXHAUSTED → Remove Trigger Tag → Enroll in Long-Term Nurture workflow.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* GHL Build Instructions */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ListChecks className="h-4 w-4 text-green-500" /> GHL Automation Setup — Re-engagement Workflow
                </CardTitle>
                <CardDescription>How to configure this sequence in GoHighLevel from scratch.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 text-xs text-muted-foreground list-none">
                  {[
                    "Reference design only: if you document this journey in GHL, name the workflow \"Liberty Bancard — Cold Lead Re-engagement\". Replit sequences, not this workflow, run the cadence.",
                    "Trigger: Contact Tag Added → Tag = COLD-NO-DEAL. This fires when the platform applies the tag via the Re-engagement dashboard.",
                    "Step 1 (immediate): Send Email → Day 60 template (subject + body from above). Use branded Liberty Bancard email template.",
                    "Step 2 (2 hours later): Send SMS → Day 60 SMS copy from above. Ensure SMS opt-in compliance.",
                    "Add Reply Detection on both email and SMS steps: If reply received → Remove from workflow → Apply tag RE-ENGAGE-REPLIED → Enroll in Workflow 3 (Reply Engaged).",
                    "Wait 30 days → Apply tag RE-ENGAGE-90 → Step 3: Send Email → Day 90 case study email. Personalize {{contact.vertical}} before activating.",
                    "Add Reply Detection on Day 90 email → If reply → stop + RE-ENGAGE-REPLIED → Workflow 3.",
                    "Wait 30 days → Step 4: Send SMS → Day 120 SMS copy. Use seasonal variant if month is Oct/Nov/Dec, otherwise non-seasonal.",
                    "Wait 7 days → If/Else: Tag = RE-ENGAGE-REPLIED? No → Apply RE-ENGAGE-EXHAUSTED → Remove COLD-NO-DEAL tag → Enroll in Long-Term Nurture workflow.",
                    "Optionally record the GHL Workflow ID at /dashboard/ghl-workflows under \"19. Reactivation — Cold Lead Revival\" as a reference-only ID; it is not required for launch.",
                  ].map((step, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/30 text-[10px] font-bold mt-0.5">
                        {i + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>

            {/* Tag Reference for Re-engagement */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Tag className="h-4 w-4" /> Re-engagement Tag Reference
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 pr-4 font-semibold text-muted-foreground">Tag</th>
                        <th className="text-left py-2 pr-4 font-semibold text-muted-foreground">When Applied</th>
                        <th className="text-left py-2 font-semibold text-muted-foreground">Effect</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { tag: "COLD-NO-DEAL", when: "Admin clicks Re-engage on Cold Lead dashboard", effect: "Triggers the re-engagement GHL workflow immediately" },
                        { tag: "RE-ENGAGE-60", when: "Applied at enrollment (Day 60 touchpoint fires)", effect: "Marks contact as in active re-engagement" },
                        { tag: "RE-ENGAGE-90", when: "Applied 30 days after Day 60 step", effect: "Day 90 case study email fires" },
                        { tag: "RE-ENGAGE-REPLIED", when: "Any reply received on any touchpoint", effect: "Stop re-engagement sequence → enroll in Workflow 3 (Reply Engaged)" },
                        { tag: "RE-ENGAGE-EXHAUSTED", when: "No response after Day 120 + 7-day wait", effect: "Remove from sequence → enroll in Long-Term Nurture" },
                      ].map((row, i) => (
                        <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="py-2.5 pr-4 font-mono font-medium">{row.tag}</td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{row.when}</td>
                          <td className="py-2.5 text-muted-foreground">{row.effect}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex items-start gap-2 p-3 rounded-md bg-muted/40 border text-xs text-muted-foreground">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <strong>COLD-NO-DEAL tag automation (optional):</strong> To auto-tag contacts without manual review,
                    create a GHL Smart List filter: Contact has form submission tag (LB-INBOUND-NEW or LB-COLD-OUTBOUND) AND
                    does NOT have tag LB-ACTIVE-PIPELINE AND contact created date is older than 60 days.
                    Then create a workflow that fires on Smart List entry → applies COLD-NO-DEAL. This enables hands-off detection,
                    while the Re-engagement dashboard remains the human review layer before outreach begins.
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Platform link */}
            <Card className="border-dashed">
              <CardContent className="pt-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <Users className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Cold Lead Re-engagement Dashboard</p>
                    <p className="text-xs text-muted-foreground">Review and manually trigger re-engagement for dormant leads.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button asChild size="sm" data-testid="btn-cold-leads-link">
                    <Link href="/dashboard/cold-leads">
                      <ArrowRight className="h-4 w-4 mr-1.5" /> Open Cold Leads
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" data-testid="btn-ghl-external-reengage">
                    <a href="https://app.gohighlevel.com" target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-1.5" /> Open GHL
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tag Reference */}
        <TabsContent value="tags" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Tag className="h-4 w-4" /> Tag Reference Table
              </CardTitle>
              <CardDescription>Every GHL tag used across the 5 workflows — what triggers it and what it does.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 pr-4 font-semibold text-muted-foreground">Tag</th>
                      <th className="text-left py-2 pr-4 font-semibold text-muted-foreground">What Triggers It</th>
                      <th className="text-left py-2 font-semibold text-muted-foreground">Effect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TAG_TABLE.map((row, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2.5 pr-4 font-mono font-medium">{row.tag}</td>
                        <td className="py-2.5 pr-4 text-muted-foreground">{row.trigger}</td>
                        <td className="py-2.5 text-muted-foreground">{row.workflow}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 p-3 rounded-md bg-muted/40 border text-xs text-muted-foreground">
                <strong>How tags work in GHL:</strong> Go to Workflows → Edit → Trigger → "Contact Tag Added" → select the tag. GHL watches for tag changes in real time. When the platform applies a tag via API, the matching workflow fires within seconds.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Global Setup */}
        <TabsContent value="global" className="mt-4">
          <div className="space-y-4">
            {GLOBAL_CHECKLIST.map((section, si) => {
              const sectionDone = section.items.filter((_, ii) => globalCheck[`${si}-${ii}`]).length;
              return (
                <Card key={si}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                        {section.section}
                      </span>
                      <Badge variant="secondary">{sectionDone}/{section.items.length}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {section.items.map((item, ii) => {
                        const key = `${si}-${ii}`;
                        return (
                          <li
                            key={ii}
                            className="flex items-start gap-2.5 cursor-pointer"
                            onClick={() => toggleGlobal(key)}
                            data-testid={`global-check-${si}-${ii}`}
                          >
                            <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors ${globalCheck[key] ? "bg-green-500 border-green-500" : "border-muted-foreground/40"}`}>
                              {globalCheck[key] && <CheckCircle2 className="h-3 w-3 text-white" />}
                            </div>
                            <span className={`text-xs ${globalCheck[key] ? "line-through text-muted-foreground" : ""}`}>{item}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </CardContent>
                </Card>
              );
            })}

            {/* Platform link card */}
            <Card className="border-dashed">
              <CardContent className="pt-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <Calendar className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Register GHL Workflow IDs</p>
                    <p className="text-xs text-muted-foreground">After building each workflow in GHL, copy its ID and paste it into the platform.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button asChild size="sm" data-testid="btn-workflow-manager">
                    <Link href="/dashboard/ghl-workflows">
                      <Settings className="h-4 w-4 mr-1.5" /> Open Workflow Manager
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" data-testid="btn-open-ghl-global">
                    <a href="https://app.gohighlevel.com" target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-1.5" /> Open GHL
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* GHL Admin Setup */}
        <TabsContent value="admin-setup" className="mt-4">
          <div className="space-y-4">
            <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
              <CardContent className="pt-4 flex gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-700 dark:text-amber-300">
                  <strong>Do this first — before building any workflow.</strong> The steps below configure the GHL account foundation that all 9 workflows depend on. Complete them in order. Each section has a progress tracker — check items off as you go.
                </div>
              </CardContent>
            </Card>

            {[
              {
                title: "1. Account & Sub-Account Setup",
                color: "border-l-blue-500",
                items: [
                  "Log in to GHL Agency Dashboard → Sub-Accounts → Create or select the Liberty Bancard sub-account",
                  "Set sub-account name: 'Liberty Bancard' | Timezone: Eastern | Business hours: Mon–Fri 9 AM–5 PM",
                  "Upload Liberty Bancard logo (Settings → Business Profile)",
                  "Set company email: the from-address for all GHL emails (e.g. scott@libertybancard.com)",
                  "Configure company phone number (Twilio) — this is the SMS from-number for all outbound texts",
                  "Verify the from-domain is authenticated in Settings → Email Services → SMTP/Mailgun",
                ],
              },
              {
                title: "2. Pipeline Setup — Match Platform Stage Names",
                color: "border-l-green-500",
                items: [
                  "Go to GHL → Pipelines → Create New Pipeline: 'Liberty Bancard Sales'",
                  "Create stages IN ORDER: New Lead → Statement Received → Review In Progress → Call Booked → Proposal Sent → Negotiation / Follow-Up → Verbal Commit → Closed Won → Closed Lost",
                  "These stage names must match the platform exactly — the platform syncs deal stage changes to GHL by name",
                  "Create a second pipeline: 'Merchant Onboarding' with stages: App Sent → App Submitted → Under Review → Approved → Terminal Shipped → Live → Churned",
                  "Set pipeline currency to USD",
                ],
              },
              {
                title: "3. Custom Fields — Contact Record",
                color: "border-l-purple-500",
                items: [
                  "Go to Settings → Custom Fields → Contacts → Create the following fields:",
                  "Text field: 'Merchant ID' (key: merchantId) — populated on approval",
                  "Text field: 'Processing Volume' (key: processingVolume) — monthly card volume",
                  "Text field: 'Current Processor' (key: currentProcessor) — incumbent name",
                  "Number field: 'Current Effective Rate' (key: currentRate) — as decimal, e.g. 0.0285",
                  "Number field: 'LB Quoted Rate' (key: lbRate) — Liberty Bancard rate",
                  "Number field: 'Monthly Savings' (key: monthlySavings) — dollar amount",
                  "Number field: 'Annual Savings' (key: annualSavings) — dollar amount",
                  "Text field: 'Vertical' (key: vertical) — business type, e.g. Restaurant",
                  "Text field: 'Terminal Type' (key: terminalType) — physical or gateway",
                  "Text field: 'Lead Source' (key: leadSource) — inbound/cold/referral/partner",
                  "Text field: 'Referral Code' (key: referralCode) — affiliate/partner referral",
                  "Number field: 'Month 1 Volume' (key: month1Volume) — first statement volume",
                  "Number field: 'Month 1 Rate' (key: month1Rate) — first statement rate",
                  "Number field: 'Cumulative Savings' (key: cumulativeSavings) — running total",
                  "Number field: 'Referral Bonus' (key: referralBonus) — $ amount earned per referral",
                ],
              },
              {
                title: "4. Custom Values (Global Tokens for Emails/SMS)",
                color: "border-l-yellow-500",
                items: [
                  "Go to Settings → Custom Values → Create the following global values:",
                  "Application Link: [paste your merchant application URL]",
                  "Statement Upload Link: [paste your upload page URL, e.g. libertybancard.com/upload-statement]",
                  "Calendar Link: [paste your GHL calendar booking link]",
                  "Merchant Portal Link: [paste your merchant portal URL]",
                  "Support Phone: (888) 555-0100",
                  "Support Email: support@libertybancard.com",
                  "These appear as {{custom.applicationLink}}, etc. in all workflow templates",
                  "Test each custom value by previewing an email template before going live",
                ],
              },
              {
                title: "5. SMS / A2P 10DLC Registration",
                color: "border-l-red-500",
                items: [
                  "Go to Settings → Phone Numbers → A2P Registration — this is REQUIRED before sending any bulk SMS",
                  "Register Brand: Legal Business Name = Liberty Bancard LLC | EIN = [your EIN] | Type = LLC",
                  "Register Campaign: Use Case = Mixed | Description = 'Merchant services outreach, rate analysis follow-ups, and customer onboarding for payment processing business'",
                  "Sample Message 1: 'Hi [name], Scott with Liberty Bancard. Want a free review of your processing costs? Reply YES. Reply STOP to opt out.'",
                  "Sample Message 2: 'Your Liberty Bancard merchant account is approved. MID: [id]. Portal: [link]. Reply STOP to opt out.'",
                  "Add opt-in language to ALL web forms: 'By submitting, you consent to receive SMS messages from Liberty Bancard. Reply STOP to unsubscribe.'",
                  "A2P approval takes 2–5 business days — do not send bulk SMS before approval",
                  "After approval: verify in GHL → Phone Numbers → your number shows 'A2P Registered'",
                ],
              },
              {
                title: "6. Voice AI Employee Setup (Phone Channel)",
                color: "border-l-violet-500",
                items: [
                  "Go to Settings → AI Employee → Create New → Select 'Phone' channel",
                  "Name: 'Liberty Bancard AI — Voice'",
                  "Paste the Voice AI system prompt from /dashboard/ghl-workflows → AI Prompts tab",
                  "Set business hours: Mon–Fri 9 AM–5 PM (contact local timezone)",
                  "Connect GHL Calendar for live appointment booking during calls",
                  "Human handoff triggers: 'real person', 'speak to someone', 'manager', 'not interested', frustration detected",
                  "Create 4 call modes (GHL calls these 'Personas' or use If/Else routing): intro_qualification | cold_outbound | follow_up_callback | proposal_reminder | onboarding_assist | statement_chase",
                  "Enable call recording for all AI voice calls (compliance + coaching)",
                  "Test: call the GHL number and verify the AI introduces itself as Liberty Bancard — NOT as ChatGPT or 'an AI'",
                ],
              },
              {
                title: "7. AI SMS Employee Setup (Text Channel)",
                color: "border-l-fuchsia-500",
                items: [
                  "Go to Settings → AI Employee → Create New → Select 'SMS/Text' channel",
                  "Name: 'Liberty Bancard AI — SMS'",
                  "Paste the SMS AI system prompt from /dashboard/ghl-workflows → AI Prompts tab (Conversation AI System Prompt section)",
                  "Human handoff triggers: 'real person', 'agent', 'speak to someone', 'human', 'ready to apply'",
                  "Connect GHL Calendar for appointment booking via SMS",
                  "Set knowledge base: attach Liberty Bancard FAQ document (create in GHL → Documents)",
                  "Enable on Workflow 1 Step 9 (Day 3 AI Conversation) — not earlier",
                  "Test: send a test SMS with 'I want to lower my processing fees' — verify AI responds correctly",
                ],
              },
              {
                title: "8. Voicemail Drop Recording & Upload",
                color: "border-l-orange-500",
                items: [
                  "Record 6 short audio files (under 25 seconds each) — use a phone recording app or a studio mic:",
                  "VM-1 (Inbound): 'Hi [name], this is Scott with Liberty Bancard calling about the request you just submitted. Give me a call back at 888-555-0100 or reply to the text we just sent. Talk soon.'",
                  "VM-2 (Cold Outbound): 'Hi [name], Scott with Liberty Bancard. Sent you a couple emails about your merchant processing — just wanted to put a voice to the name. Call me at 888-555-0100 or reply to my email.'",
                  "VM-3 (Reply Engaged): 'Hi [name], Scott from Liberty Bancard. Just making sure you didn't fall through the cracks — you reached out and I want to take care of you. 888-555-0100 or grab a time on my calendar. Sending the link now.'",
                  "VM-4 (Statement Chase): 'Hi [name], Scott from Liberty Bancard. Following up on the statement review — if you want to send it, just reply to one of my texts with a photo or PDF. Hope to hear from you soon.'",
                  "VM-5 (Proposal): 'Hi [name], Scott from Liberty Bancard. Wanted to touch base on the analysis I sent — there's a real opportunity here and I don't want you to miss it. Call me at 888-555-0100 or grab a time on my calendar.'",
                  "VM-6 (Onboarding): 'Hi [name], Scott from Liberty Bancard checking in on your application — just want to make sure you don't hit any snags. Call me at 888-555-0100 or reply to any of my messages.'",
                  "Upload all files: GHL → Marketing → Files & Media → Upload Audio",
                  "In each workflow's voicemail step: Actions → Voicemail Drop → select the matching audio file",
                ],
              },
              {
                title: "9. GHL Calendar Configuration",
                color: "border-l-teal-500",
                items: [
                  "Go to Calendars → Create Calendar → 'Liberty Bancard — Statement Review Call'",
                  "Duration: 15 minutes | Buffer after: 5 minutes",
                  "Availability: Mon–Fri 9 AM–5 PM Eastern (or rep's local timezone)",
                  "Confirmation email: auto-send with GHL template; include statement upload link in confirmation",
                  "Reminder: SMS 1 hour before + email 24 hours before",
                  "No-show automation: if appointment no-show → apply tag LB-NO-SHOW → enroll in No-Show Recovery workflow",
                  "Connect to Voice AI Employee so AI can book appointments during calls",
                  "Paste calendar booking URL into the 'Calendar Link' custom value (Step 4 above)",
                  "Test: book a test appointment and verify all confirmation/reminder messages fire",
                ],
              },
              {
                title: "10. Smart Lists — Lead Prioritization Views",
                color: "border-l-sky-500",
                items: [
                  "Go to Contacts → Smart Lists → Create the following views:",
                  "🔥 Hot Inbound (Today): Tag = LB-INBOUND-NEW AND Tag added date = today",
                  "💬 Replied — Needs Response: Tag = LB-SDR-REPLY-ENGAGED AND Tag added = last 48h",
                  "📄 Statement Pending: Tag = LB-SDR-STATEMENT-CHASE (active, no LB-STATEMENT-RECEIVED)",
                  "📊 Proposal Out: Pipeline Stage = Proposal Sent",
                  "❄️ Cold Active: Tag = LB-COLD-OUTBOUND AND does NOT have tag LB-COLD-EXIT",
                  "🏗️ Onboarding Active: Tag = LB-CLOSED-WON AND does NOT have tag LB-MERCHANT-APPROVED",
                  "⚠️ Onboarding Stalled: Tag = LB-ONBOARDING-STALLED",
                  "📈 Active Merchants: Tag = LB-MERCHANT-ACTIVE",
                  "😞 At Risk (NPS Detractors): Tag = LB-NPS-DETRACTOR",
                  "🛑 DNC (Never Contact): Tag = LB-DNC — review this list periodically to confirm",
                ],
              },
              {
                title: "11. Register All Workflow IDs in the Platform",
                color: "border-l-emerald-500",
                items: [
                  "After building each workflow in GHL: go to Automations → your workflow → Settings → copy the Workflow ID",
                  "Go to /dashboard/ghl-workflows in this platform",
                  "Paste each workflow ID next to its sequence name:",
                  "WF1 (Speed-to-Lead) → sequence name: 'Inbound Confirmation'",
                  "WF2 (Cold Outbound) → sequence name: 'Switch & Save — Statement Audit'",
                  "WF3 (Reply Engaged) → sequence name: 'SDR: Reply Engaged'",
                  "WF4 (Statement Chase) → sequence name: 'SDR: Statement Chase'",
                  "WF5 (Proposal) → sequence name: 'SDR: Proposal Follow-Up'",
                  "WF6 (Merchant Welcome) → sequence name: '3. Fast Approval — Application Completion'",
                  "WF7 (Go-Live) → env var: GHL_WORKFLOW_MERCHANT_APPROVED (set in Replit Secrets)",
                  "WF8 (Retention) → create new sequence name: 'Merchant Retention — NPS'",
                  "WF9 (Win-Back) → create new sequence name: 'Merchant Win-Back'",
                  "Re-engagement → sequence name: '19. Reactivation — Cold Lead Revival'",
                  "Test each: manually apply trigger tag to a test contact → verify GHL fires the workflow within 30 seconds",
                ],
              },
              {
                title: "12. Go-Live Final Check",
                color: "border-l-rose-500",
                items: [
                  "A2P SMS registration approved ✓",
                  "All 9 workflows built and tested with a test contact ✓",
                  "All voicemail drop audio files uploaded ✓",
                  "Voice AI Employee tested — introduces as Liberty Bancard, not ChatGPT ✓",
                  "SMS AI Employee tested — handles objections, books appointments ✓",
                  "All custom values populated (application link, calendar, portal, upload links) ✓",
                  "All GHL Workflow IDs registered in the platform at /dashboard/ghl-workflows ✓",
                  "DNC handling tested — STOP reply stops all sequences immediately ✓",
                  "Go to /dashboard/activation → enable SDR sequences → flip SDR_ENABLED to ON ✓",
                  "Monitor /dashboard/operator for the first 48 hours — watch for bounce spikes or anomalies ✓",
                ],
              },
            ].map((section, si) => (
              <AdminCheckSection key={si} sectionIndex={si} title={section.title} color={section.color} items={section.items} />
            ))}

            <Card className="border-dashed">
              <CardContent className="pt-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <Zap className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Ready to activate?</p>
                    <p className="text-xs text-muted-foreground">Once all 12 sections are complete, flip the master switch in the Activation Panel.</p>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button asChild size="sm" data-testid="btn-activation-panel">
                    <Link href="/dashboard/activation">
                      <Zap className="h-4 w-4 mr-1.5" /> Activation Panel
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" data-testid="btn-ghl-admin-external">
                    <a href="https://app.gohighlevel.com" target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-1.5" /> Open GHL
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── EMAIL LIBRARY ─────────────────────────────────────────────── */}
        <TabsContent value="email-library" className="mt-4">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Mail className="h-5 w-5 text-blue-500" /> Email Template Library
                </CardTitle>
                <CardDescription>
                  Every email from all 9 workflows — expand to copy subject + body straight into GHL.
                  Go to <strong>Marketing → Email Templates → + New Template</strong> for each one.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  {[
                    { color: "blue", title: "GHL Location", body: "Marketing → Email Templates → + New" },
                    { color: "green", title: "Naming Convention", body: "WF[#]-Step[#] — Short Description" },
                    { color: "purple", title: "Reply-To Address", body: "scott@libertybancard.com" },
                    { color: "orange", title: "Compliance Footer", body: "Eligibility, underwriting, and card brand rules apply." },
                  ].map(({ color, title, body }) => (
                    <div key={title} className={`bg-${color}-50 dark:bg-${color}-900/20 border border-${color}-200 dark:border-${color}-800 rounded p-2`}>
                      <p className={`font-semibold text-${color}-700 dark:text-${color}-300`}>{title}</p>
                      <p className={`text-${color}-600 dark:text-${color}-400 mt-0.5`}>{body}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {WORKFLOWS.map((wf) => {
              const emailSteps = wf.steps.filter(s => s.channel === "email");
              if (emailSteps.length === 0) return null;
              return (
                <Card key={wf.id}>
                  <CardHeader className="pb-2">
                    <div className={`border-l-4 ${wf.color} pl-3`}>
                      <CardTitle className="text-sm">{wf.name}</CardTitle>
                      <CardDescription className="text-xs mt-0.5">
                        {emailSteps.length} email{emailSteps.length !== 1 ? "s" : ""} · Trigger tag: <span className="font-mono">{wf.triggerTag}</span>
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {emailSteps.map(step => (
                      <div key={step.num} className="border rounded-lg overflow-hidden">
                        <div className="flex items-center gap-3 p-3 bg-muted/30 flex-wrap">
                          <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 text-xs gap-1 shrink-0">
                            <Mail className="h-3 w-3" /> Step {step.num}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{step.delay}</span>
                          {step.subject && <span className="text-xs font-medium truncate flex-1 italic">"{step.subject}"</span>}
                        </div>
                        <div className="p-3 space-y-2">
                          {step.subject && <CopyBlock text={step.subject} label="Subject Line" />}
                          <CopyBlock text={step.copy} label="Email Body — paste into GHL HTML editor" />
                          {step.ghlNote && (
                            <div className="flex gap-2 p-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                              <Settings className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                              <p className="text-xs text-blue-700 dark:text-blue-300">{step.ghlNote}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
            })}

            <Card className="border-dashed">
              <CardContent className="pt-4 space-y-2">
                <p className="text-sm font-semibold">GHL Email Template Quick-Build Steps</p>
                <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Go to <strong>Marketing → Email Templates → + New Template</strong></li>
                  <li>Name it: <code className="bg-muted px-1 rounded">WF1-Step1-Inbound-Confirm</code> (use the naming convention above)</li>
                  <li>Paste subject line → paste email body in the HTML/source editor</li>
                  <li>Add Liberty Bancard logo header + signature block + compliance footer</li>
                  <li>Set Reply-To: <strong>scott@libertybancard.com</strong> in template settings</li>
                  <li>Save → go to the matching workflow step → <strong>Actions → Send Email → pick this template</strong></li>
                  <li>Click <strong>Send Test Email</strong> in GHL before activating the workflow</li>
                </ol>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── MANUAL SEQUENCES ─────────────────────────────────────────────── */}
        <TabsContent value="manual-sequences" className="mt-4">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardList className="h-5 w-5 text-slate-500" /> Manual Sequences
                </CardTitle>
                <CardDescription>
                  Rep-driven outreach sequences for situations not covered by the 9 automated workflows.
                  Build each in GHL under <strong>Automations → + New Workflow</strong> — set trigger to <strong>Manual Trigger</strong> so reps can fire them on demand from a contact record.
                </CardDescription>
              </CardHeader>
            </Card>

            {[
              {
                id: "cold-email-blast",
                name: "Manual — Cold Business Email (Bulk Outbound)",
                color: "border-sky-500",
                goal: "One-shot or drip email to a cold list (trade show, purchased list, Sunbiz import). Reps fire this on any contact not yet in WF2.",
                trigger: "Manual Trigger — rep applies from contact record or Smart List bulk action",
                triggerTag: "LB-MANUAL-COLD-EMAIL",
                when: "Sunbiz/Apollo imports, event leads, partner referrals not yet reached",
                steps: [
                  { day: "Day 0", type: "Email", subject: "Quick question about your processing costs, {{contact.firstName}}", body: `Hi {{contact.firstName}},

I noticed {{contact.companyName}} and wanted to reach out — we work with businesses in {{contact.city}} to cut payment processing costs, often by 20–40%.

Takes 5 minutes: just send us your last merchant statement and we'll show you exactly what you're paying vs. what you could be paying.

No obligation, no pitch — just numbers.

Worth a look?

— Scott Allen, Liberty Bancard
📞 (888) 555-0100

Eligibility, underwriting, and card brand rules apply.` },
                  { day: "Day 3", type: "Email", subject: "Still thinking about it, {{contact.firstName}}?", body: `Hi {{contact.firstName}},

Just following up on my note from a few days ago.

Most business owners we work with were surprised by how much they were overpaying — the average we save is $400–$800/month.

If you'd like a free analysis, just reply with your last processor statement. We'll turn it around in 24 hours.

— Scott Allen, Liberty Bancard
📞 (888) 555-0100

Eligibility, underwriting, and card brand rules apply.` },
                  { day: "Day 7", type: "Email", subject: "Last note from me, {{contact.firstName}}", body: `Hi {{contact.firstName}},

I don't want to clutter your inbox, so this will be my last reach-out for now.

If your processing costs ever become a priority, I'm here: scott@libertybancard.com or (888) 555-0100.

We'll have your savings analysis ready within 24 hours of receiving a statement.

Take care,
— Scott Allen, Liberty Bancard

Eligibility, underwriting, and card brand rules apply.` },
                ],
                ghlBuild: [
                  "Automations → + New Workflow → name: 'Manual — Cold Business Email'",
                  "Trigger: Manual Trigger (this lets reps fire it from any contact record)",
                  "Step 1: Send Email → WF-Manual-Cold-Email-1 template → Send immediately",
                  "Step 2: Wait → 3 days",
                  "Step 3: IF/ELSE → Contact has tag LB-SDR-REPLY-ENGAGED → YES: apply tag LB-COLD-EXIT and STOP / NO: continue",
                  "Step 4: Send Email → WF-Manual-Cold-Email-2 template",
                  "Step 5: Wait → 4 days",
                  "Step 6: IF/ELSE → Reply engaged? → YES: EXIT / NO: Send Email 3",
                  "Step 7: Send Email → WF-Manual-Cold-Email-3 (breakup email)",
                  "Step 8: Apply tag LB-COLD-EXIT → End workflow",
                  "Activate → save as 'Published'",
                ],
              },
              {
                id: "event-lead",
                name: "Manual — Event / Trade Show Lead Nurture",
                color: "border-emerald-500",
                goal: "Follow up with contacts met in person at trade shows, networking events, or referral intros. Warmer tone — you've already met.",
                trigger: "Manual Trigger — rep fires within 24h of meeting the contact",
                triggerTag: "LB-MANUAL-EVENT-LEAD",
                when: "After trade shows, BNI meetings, chamber events, in-person demos, partner intros",
                steps: [
                  { day: "Day 0", type: "Email", subject: "Great meeting you at {{custom.eventName}}, {{contact.firstName}}", body: `Hi {{contact.firstName}},

Really enjoyed our conversation at {{custom.eventName}} — I meant it when I said there's a real opportunity to lower your processing costs.

Here's what I'd love to do: take a look at your current merchant statement and put together a side-by-side comparison. No cost, no commitment — just a clear picture of what you could save.

When you're ready, just reply and attach it. I'll have your analysis back within 24 hours.

Great meeting you,
— Scott Allen, Liberty Bancard
📞 (888) 555-0100

Eligibility, underwriting, and card brand rules apply.` },
                  { day: "Day 2", type: "SMS", body: "Hi {{contact.firstName}}, Scott from Liberty Bancard — great meeting you! If you find that merchant statement, just reply with a photo or PDF and I'll run your analysis. Reply STOP to opt out." },
                  { day: "Day 5", type: "Email", subject: "Still here when you're ready, {{contact.firstName}}", body: `Hi {{contact.firstName}},

No pressure at all — just wanted to make sure I stayed on your radar.

When the timing works, I'm one email away. Reply here or grab 15 minutes on my calendar: {{custom.calendarLink}}

— Scott Allen, Liberty Bancard

Eligibility, underwriting, and card brand rules apply.` },
                ],
                ghlBuild: [
                  "Automations → + New Workflow → name: 'Manual — Event Lead Nurture'",
                  "Trigger: Manual Trigger",
                  "Step 1: Apply tag LB-MANUAL-EVENT-LEAD",
                  "Step 2: Send Email → Event Lead Email 1 (Day 0 — warm intro follow-up)",
                  "Step 3: Wait → 2 days",
                  "Step 4: IF/ELSE → has tag LB-SDR-REPLY-ENGAGED → EXIT / else: Send SMS",
                  "Step 5: Wait → 3 days",
                  "Step 6: IF/ELSE → reply engaged? → EXIT / else: Send Email 2 (Day 5 soft check-in)",
                  "Step 7: Apply tag LB-COLD-EXIT → End",
                  "Note: Create a GHL Custom Value 'eventName' so reps can set the event name per contact",
                ],
              },
              {
                id: "partner-referral",
                name: "Manual — Partner / ISO Referral Nurture",
                color: "border-violet-500",
                goal: "Warm-touch sequence for leads referred by ISOs, CPAs, bookkeepers, or chamber partners. Higher trust — reference the referrer name.",
                trigger: "Manual Trigger — fired when a referral is logged from a partner",
                triggerTag: "LB-MANUAL-PARTNER-REFERRAL",
                when: "Any time a partner submits a referral through the platform or directly to a rep",
                steps: [
                  { day: "Day 0", type: "Email", subject: "{{contact.firstName}}, {{custom.referrerName}} suggested we connect", body: `Hi {{contact.firstName}},

{{custom.referrerName}} mentioned you might benefit from a review of your payment processing costs — I work with a lot of businesses in your space and wanted to reach out.

We typically find 20–40% in savings just by analyzing the current statement. No cost, no obligation — just a clear, honest comparison.

Would you be open to a quick look? If you have your last merchant statement handy, just reply and attach it.

Looking forward to connecting,
— Scott Allen, Liberty Bancard
📞 (888) 555-0100

Eligibility, underwriting, and card brand rules apply.` },
                  { day: "Day 3", type: "Email", subject: "Following up on {{custom.referrerName}}'s intro, {{contact.firstName}}", body: `Hi {{contact.firstName}},

I know you're busy — just wanted to make sure my first note didn't get buried.

The analysis takes 24 hours and gives you a clear dollar amount you could save per month. Most business owners find it eye-opening.

Want me to run it? Just reply with your current statement.

— Scott Allen, Liberty Bancard

Eligibility, underwriting, and card brand rules apply.` },
                  { day: "Day 7", type: "Email", subject: "One last note, {{contact.firstName}}", body: `Hi {{contact.firstName}},

I'll keep this short — if cost savings on processing ever become a priority, I'm at scott@libertybancard.com or (888) 555-0100.

I'll let {{custom.referrerName}} know I tried!

Best,
— Scott Allen, Liberty Bancard

Eligibility, underwriting, and card brand rules apply.` },
                ],
                ghlBuild: [
                  "Automations → + New Workflow → name: 'Manual — Partner Referral Nurture'",
                  "Trigger: Manual Trigger",
                  "Before firing: set Custom Value 'referrerName' on the contact record (partner's name)",
                  "Step 1: Send Email → Partner Referral Email 1",
                  "Step 2: Wait → 3 days",
                  "Step 3: IF/ELSE → reply engaged → EXIT → else: Send Email 2",
                  "Step 4: Wait → 4 days",
                  "Step 5: IF/ELSE → reply engaged → EXIT → else: Send Email 3 (wrap-up)",
                  "Step 6: Apply tag LB-COLD-EXIT → Notify rep via Internal Task → End",
                  "GHL Custom Values needed: referrerName, calendarLink, applicationLink",
                ],
              },
              {
                id: "stalled-deal",
                name: "Manual — Stalled Deal Revival",
                color: "border-rose-500",
                goal: "Re-engage a prospect who was in the pipeline (had a conversation, requested analysis) but went quiet. More direct and personal than cold outbound.",
                trigger: "Manual Trigger — rep fires when deal has had no activity for 14+ days",
                triggerTag: "LB-MANUAL-STALLED",
                when: "Deal in pipeline with no response for 14+ days, not in an active automated workflow",
                steps: [
                  { day: "Day 0", type: "Email", subject: "Checking in, {{contact.firstName}} — did I lose you?", body: `Hi {{contact.firstName}},

I noticed we haven't connected in a while and wanted to check in.

Last time we spoke, you were looking at [deal context]. I don't want you to miss out on the savings if the timing is right now.

Is there anything I can help clarify or move forward? Happy to jump on a quick call.

— Scott Allen, Liberty Bancard
📞 (888) 555-0100

Eligibility, underwriting, and card brand rules apply.` },
                  { day: "Day 3", type: "SMS", body: "Hi {{contact.firstName}}, Scott from Liberty Bancard — sent you an email a couple days ago. Did you want to pick up where we left off? Reply YES or just call me at 888-555-0100. Reply STOP to opt out." },
                  { day: "Day 6", type: "Email", subject: "Closing out your file, {{contact.firstName}}", body: `Hi {{contact.firstName}},

I want to respect your time, so I'll keep this brief.

If now isn't the right time, I completely understand — I'll close out the file on my end and circle back down the road.

If you do want to revisit, just reply and I'll pick right back up. We can have your analysis ready in 24 hours.

Either way, thanks for the conversation.

— Scott Allen, Liberty Bancard

Eligibility, underwriting, and card brand rules apply.` },
                ],
                ghlBuild: [
                  "Automations → + New Workflow → name: 'Manual — Stalled Deal Revival'",
                  "Trigger: Manual Trigger",
                  "Step 1: Apply tag LB-MANUAL-STALLED",
                  "Step 2: Send Email → Stalled Revival Email 1 (personal check-in)",
                  "Step 3: Wait → 3 days",
                  "Step 4: IF/ELSE → reply engaged → EXIT to WF3 (Reply Engaged) → else: Send SMS",
                  "Step 5: Wait → 3 days",
                  "Step 6: IF/ELSE → reply engaged → EXIT → else: Send Email 2 (closing email)",
                  "Step 7: Apply tag LB-COLD-EXIT → Create Internal Task for rep review → End",
                  "Rep Note: Before firing this, update the deal notes in the platform so the email context is current",
                ],
              },
              {
                id: "no-show-recovery",
                name: "Manual — No-Show Appointment Recovery",
                color: "border-amber-500",
                goal: "Recover a prospect who booked a call but didn't show. Fast, casual, non-confrontational. Goal is to reschedule within 48 hours.",
                trigger: "Manual Trigger — fired automatically by GHL no-show tag or by rep within 1h of missed appointment",
                triggerTag: "LB-NO-SHOW",
                when: "Any contact who had a confirmed appointment and did not join/answer",
                steps: [
                  { day: "Day 0 (within 1hr)", type: "SMS", body: "Hi {{contact.firstName}}, Scott from Liberty Bancard — looks like we missed each other on our call. No worries! Grab a new time here: {{custom.calendarLink}} or just reply and I'll find a slot. Reply STOP to opt out." },
                  { day: "Day 0 (within 2hr)", type: "Email", subject: "Missed you on our call — want to reschedule?", body: `Hi {{contact.firstName}},

We had a call scheduled today and I wasn't able to reach you — completely understand, things come up.

When you're ready to connect, grab a time that works here: {{custom.calendarLink}}

Or just reply and I'll send a few options.

— Scott Allen, Liberty Bancard
📞 (888) 555-0100

Eligibility, underwriting, and card brand rules apply.` },
                  { day: "Day 2", type: "Email", subject: "Still want to show you the numbers, {{contact.firstName}}", body: `Hi {{contact.firstName}},

I still have your savings analysis ready to go — I just need 15 minutes.

Pick a time: {{custom.calendarLink}}

Or call me directly at (888) 555-0100.

— Scott Allen, Liberty Bancard

Eligibility, underwriting, and card brand rules apply.` },
                ],
                ghlBuild: [
                  "Automations → + New Workflow → name: 'Manual — No-Show Recovery'",
                  "Trigger: Contact Tag Added = LB-NO-SHOW (GHL can auto-fire this from Calendar → No-Show settings)",
                  "Step 1: Wait → 30 minutes (allow GHL to detect no-show)",
                  "Step 2: Send SMS → No-Show SMS (reschedule link)",
                  "Step 3: Wait → 1 hour",
                  "Step 4: Send Email → No-Show Email 1",
                  "Step 5: Wait → 2 days",
                  "Step 6: IF/ELSE → appointment rebooked (tag LB-BOOKING-READY) → EXIT / else: Send Email 2",
                  "Step 7: Create Internal Task: 'No-show — call prospect directly' → Assign to rep → End",
                  "Calendar Setup: Calendars → your calendar → Notifications → No-Show → apply tag LB-NO-SHOW",
                ],
              },
            ].map((seq) => (
              <Card key={seq.id}>
                <CardHeader className="pb-2">
                  <div className={`border-l-4 ${seq.color} pl-3`}>
                    <CardTitle className="text-sm">{seq.name}</CardTitle>
                    <CardDescription className="text-xs mt-0.5">{seq.goal}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline" className="font-mono gap-1"><Tag className="h-3 w-3" />{seq.triggerTag}</Badge>
                    <Badge variant="secondary">{seq.trigger}</Badge>
                  </div>
                  <div className="bg-muted/40 rounded p-2 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">When to use: </span>{seq.when}
                  </div>

                  <div>
                    <p className="text-xs font-semibold mb-2 flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> Message Steps</p>
                    <div className="space-y-2">
                      {seq.steps.map((step, si) => (
                        <div key={si} className="border rounded-lg overflow-hidden">
                          <div className="flex items-center gap-2 p-2 bg-muted/30 flex-wrap">
                            <Badge variant="outline" className="text-xs">{step.day}</Badge>
                            <Badge className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">{step.type}</Badge>
                            {step.subject && <span className="text-xs text-muted-foreground italic truncate">"{step.subject}"</span>}
                          </div>
                          <div className="p-2 space-y-1.5">
                            {"subject" in step && step.subject && <CopyBlock text={step.subject} label="Subject" />}
                            <CopyBlock text={step.body} label={step.type === "SMS" ? "SMS Text" : "Email Body"} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold mb-2 flex items-center gap-1.5"><Settings className="h-3.5 w-3.5" /> GHL Build Instructions</p>
                    <div className="bg-muted/30 rounded-md p-3">
                      <ol className="space-y-1">
                        {seq.ghlBuild.map((step, si) => (
                          <li key={si} className="flex gap-2 text-xs text-muted-foreground">
                            <span className="shrink-0 w-4 text-right font-mono text-muted-foreground/60">{si + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── MULTI-TOUCH MAP ─────────────────────────────────────────────── */}
        <TabsContent value="multi-touch" className="mt-4">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ListChecks className="h-5 w-5 text-emerald-500" /> Multi-Touch Campaign Map
                </CardTitle>
                <CardDescription>
                  Master reference of every outreach campaign — all 9 automated workflows + 5 manual sequences — showing each touchpoint, channel, timing, and GHL action in one view.
                  Use this to plan your GHL build order and verify no gaps.
                </CardDescription>
              </CardHeader>
            </Card>

            {/* Build Order Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4 text-yellow-500" /> Recommended GHL Build Order</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  {[
                    {
                      phase: "Phase 1 — Foundation (Week 1)",
                      color: "border-blue-400",
                      items: [
                        "✓ A2P SMS Registration (required before any bulk SMS)",
                        "✓ GHL Calendar setup (15-min Statement Review Call)",
                        "✓ Custom Values (calendarLink, applicationLink, portalLink)",
                        "✓ Voicemail Drop recordings uploaded (6 audio files)",
                        "✓ WF1 — Speed-to-Lead (highest ROI, build first)",
                        "✓ WF2 — Cold Outbound (main volume driver)",
                      ],
                    },
                    {
                      phase: "Phase 2 — Conversion (Week 2)",
                      color: "border-green-400",
                      items: [
                        "✓ WF3 — Reply Engaged (critical: handles all inbound replies)",
                        "✓ WF4 — Statement Chase (converts interested to submitted)",
                        "✓ WF5 — Proposal Follow-Up (closes deals)",
                        "✓ Manual: No-Show Recovery (fires from calendar no-show tag)",
                        "✓ Manual: Stalled Deal Revival",
                        "✓ All email templates created and tested",
                      ],
                    },
                    {
                      phase: "Phase 3 — Merchant Lifecycle (Week 3)",
                      color: "border-purple-400",
                      items: [
                        "✓ WF6 — Merchant Welcome (Closed Won trigger)",
                        "✓ WF7 — Go-Live & Approval",
                        "✓ WF8 — Retention & NPS (Day 32 post-go-live)",
                        "✓ WF9 — Win-Back (churned merchants)",
                        "✓ Manual: Cold Business Email + Event Lead + Partner Referral",
                        "✓ Voice AI + SMS AI Employees configured and tested",
                      ],
                    },
                  ].map(({ phase, color, items }) => (
                    <div key={phase} className={`border-l-4 ${color} pl-3 space-y-1`}>
                      <p className="font-semibold text-xs mb-2">{phase}</p>
                      {items.map((item, i) => <p key={i} className="text-muted-foreground">{item}</p>)}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Campaign Touch Table */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Campaign Touch Timeline — All Automated Workflows</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left p-3 font-semibold w-40">Campaign</th>
                      <th className="text-left p-3 font-semibold">Trigger Tag</th>
                      <th className="text-left p-3 font-semibold">Touches</th>
                      <th className="text-left p-3 font-semibold">Duration</th>
                      <th className="text-left p-3 font-semibold">Channels</th>
                      <th className="text-left p-3 font-semibold">Primary Goal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { name: "WF1 Speed-to-Lead", tag: "LB-INBOUND-NEW", touches: "10+", duration: "10 days", channels: "Email, SMS, Voice, VM, AI", goal: "Book call within 60 sec of form submit", color: "bg-blue-500" },
                      { name: "WF2 Cold Outbound", tag: "LB-COLD-OUTBOUND", touches: "12", duration: "30 days", channels: "Email, SMS, Voice, VM, Task", goal: "Convert cold prospect to statement submission", color: "bg-slate-500" },
                      { name: "WF3 Reply Engaged", tag: "LB-SDR-REPLY-ENGAGED", touches: "6", duration: "5 days", channels: "Email, SMS, Voice, Task", goal: "Fast-track interested prospect to booked call", color: "bg-green-500" },
                      { name: "WF4 Statement Chase", tag: "LB-SDR-STATEMENT-CHASE", touches: "8", duration: "14 days", channels: "Email, SMS, Voice, VM", goal: "Get statement uploaded for analysis", color: "bg-yellow-500" },
                      { name: "WF5 Proposal Follow", tag: "LB-SDR-PROPOSAL", touches: "6", duration: "10 days", channels: "Email, SMS, Voice", goal: "Convert proposal viewed → verbal commit", color: "bg-orange-500" },
                      { name: "WF6 Merchant Welcome", tag: "LB-CLOSED-WON", touches: "5", duration: "7 days", channels: "Email, SMS, Task", goal: "Welcome → get application submitted", color: "bg-purple-500" },
                      { name: "WF7 Go-Live", tag: "LB-MERCHANT-APPROVED", touches: "4", duration: "14 days", channels: "Email, SMS, Voice, Task", goal: "Terminal active + first transaction", color: "bg-indigo-500" },
                      { name: "WF8 Retention & NPS", tag: "LB-MERCHANT-ACTIVE", touches: "5", duration: "45 days", channels: "Email, SMS", goal: "NPS survey + referral ask + upsell", color: "bg-teal-500" },
                      { name: "WF9 Win-Back", tag: "LB-MERCHANT-CHURNED", touches: "5", duration: "30 days", channels: "Email, SMS, Voice", goal: "Re-win churned merchant", color: "bg-rose-500" },
                    ].map((row) => (
                      <tr key={row.name} className="border-b hover:bg-muted/20 transition-colors">
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${row.color} shrink-0`} />
                            <span className="font-medium">{row.name}</span>
                          </div>
                        </td>
                        <td className="p-3 font-mono text-muted-foreground">{row.tag}</td>
                        <td className="p-3 font-semibold text-center">{row.touches}</td>
                        <td className="p-3 text-muted-foreground">{row.duration}</td>
                        <td className="p-3 text-muted-foreground">{row.channels}</td>
                        <td className="p-3 text-muted-foreground">{row.goal}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Manual Sequences Summary Table */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Manual Sequences Summary</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left p-3 font-semibold w-48">Sequence</th>
                      <th className="text-left p-3 font-semibold">When to Fire</th>
                      <th className="text-left p-3 font-semibold">Touches</th>
                      <th className="text-left p-3 font-semibold">Duration</th>
                      <th className="text-left p-3 font-semibold">Channels</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { name: "Cold Business Email", when: "Sunbiz/Apollo import, any cold list", touches: "3", duration: "7 days", channels: "Email ×3" },
                      { name: "Event / Trade Show Lead", when: "Within 24h of in-person meeting", touches: "3", duration: "5 days", channels: "Email ×2, SMS ×1" },
                      { name: "Partner Referral Nurture", when: "ISO/CPA/bookkeeper referral received", touches: "3", duration: "7 days", channels: "Email ×3" },
                      { name: "Stalled Deal Revival", when: "Pipeline deal silent 14+ days", touches: "3", duration: "6 days", channels: "Email ×2, SMS ×1" },
                      { name: "No-Show Recovery", when: "Within 1h of missed appointment", touches: "3", duration: "2 days", channels: "SMS ×1, Email ×2" },
                    ].map((row) => (
                      <tr key={row.name} className="border-b hover:bg-muted/20 transition-colors">
                        <td className="p-3 font-medium">{row.name}</td>
                        <td className="p-3 text-muted-foreground">{row.when}</td>
                        <td className="p-3 font-semibold text-center">{row.touches}</td>
                        <td className="p-3 text-muted-foreground">{row.duration}</td>
                        <td className="p-3 text-muted-foreground">{row.channels}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* AI Prompts Quick Reference */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><Bot className="h-4 w-4 text-fuchsia-500" /> AI Employee Prompt Guidelines (GHL)</CardTitle>
                <CardDescription className="text-xs">Paste these into GHL → Settings → AI Employee when setting up Voice and SMS AI channels.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <CopyBlock label="Voice AI System Prompt (GHL → AI Employee → Phone Channel)" text={`You are a friendly, professional sales representative for Liberty Bancard, a merchant payment processing company based in the United States. Your name is Alex.

IDENTITY RULES:
- You work FOR Liberty Bancard — do NOT say you are ChatGPT, an AI assistant, or a bot.
- If asked "Are you a real person?" or "Are you AI?", say: "I'm an AI assistant for Liberty Bancard. I'm here to help answer your questions and connect you with our team."
- Never deny being an AI when directly and sincerely asked.

YOUR GOAL:
- Qualify the prospect (do they process credit cards? how much per month? who is their current processor?)
- Book a 15-minute statement review call with a human rep
- Collect the prospect's email if not on file

QUALIFICATION QUESTIONS (ask naturally, not as a list):
1. "Do you currently accept credit card payments in your business?"
2. "About how much do you process in credit card sales each month?"
3. "Who is your current payment processor?" (Stripe, Square, Heartland, First Data, etc.)
4. "Are you happy with your current rates, or have you looked at alternatives?"

BOOKING:
- If qualified (processes >$5k/month), offer to book a 15-minute call: "I'd love to set up a quick 15-minute call with our team — we can show you exactly what you're paying vs. what you could be paying. Does [day] or [day] work?"
- Use the GHL calendar integration to book directly during the call.

OBJECTION HANDLING:
- "I'm happy with my current processor": "That's great — we actually love working with businesses that are already set up. We just want to make sure you're not overpaying. The analysis is free and takes 24 hours."
- "I'm too busy": "Completely understand. Can I send you a quick email so you have it when you have a moment?"
- "Not interested": Politely thank them and let a human rep know.

COMPLIANCE:
- Do not make specific rate guarantees during the call.
- Always say: "Eligibility, underwriting, and card brand rules apply."
- End all calls with: "Thanks for your time — have a great day!"`} />

                <CopyBlock label="SMS AI System Prompt (GHL → AI Employee → SMS/Text Channel)" text={`You are a helpful SMS assistant for Liberty Bancard, a payment processing company. Your name is Alex.

IDENTITY:
- You are an AI assistant for Liberty Bancard.
- If asked "Is this a real person?" say: "I'm an automated assistant for Liberty Bancard. A real team member can follow up if you prefer — just say 'human' anytime."

YOUR GOALS via SMS:
1. Answer basic questions about Liberty Bancard services
2. Qualify the prospect (do they take credit cards? volume?)
3. Direct them to book a call or upload their statement

KEEP IT SHORT: SMS responses should be 1–3 sentences max. Never send walls of text.

TRIGGERS FOR HUMAN HANDOFF (immediately notify a rep):
- "real person", "human", "agent", "speak to someone"
- "ready to apply", "ready to sign up"
- "not interested", "stop contacting me"
- Any negative sentiment or frustration detected

BOOKING: If prospect wants to book, send: "Great! You can grab a time here: {{custom.calendarLink}}"

STATEMENT UPLOAD: If prospect wants the analysis, send: "Perfect — just upload your last merchant statement here: {{custom.statementUploadLink}} and we'll have your savings report within 24 hours."

COMPLIANCE:
- Always include opt-out reminder on first message: "Reply STOP to opt out."
- Do not make rate guarantees.
- Eligibility, underwriting, and card brand rules apply.`} />
              </CardContent>
            </Card>

            {/* GHL Workflow ID Registry Quick Reference */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><Settings className="h-4 w-4" /> GHL Workflow ID Registry — Quick Reference</CardTitle>
                <CardDescription className="text-xs">After building each workflow in GHL, copy its Workflow ID and paste it in the platform at <strong>/dashboard/ghl-workflows</strong>. This links the platform to GHL so auto-enrollment works.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left p-3 font-semibold">Workflow Name in GHL</th>
                      <th className="text-left p-3 font-semibold">Sequence Name in Platform</th>
                      <th className="text-left p-3 font-semibold">Trigger Event</th>
                      <th className="text-left p-3 font-semibold">Env Var (if applicable)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { ghl: "LB — Speed-to-Lead (WF1)", platform: "Inbound Confirmation", trigger: "Web form submission", env: "—" },
                      { ghl: "LB — Cold Outbound (WF2)", platform: "Switch & Save — Statement Audit", trigger: "Tag: LB-COLD-OUTBOUND added", env: "—" },
                      { ghl: "LB — Reply Engaged (WF3)", platform: "SDR: Reply Engaged", trigger: "Inbound email/SMS reply detected", env: "—" },
                      { ghl: "LB — Statement Chase (WF4)", platform: "SDR: Statement Chase", trigger: "Tag: LB-SDR-STATEMENT-CHASE", env: "—" },
                      { ghl: "LB — Proposal Follow-Up (WF5)", platform: "SDR: Proposal Follow-Up", trigger: "Proposal delivered (tag applied)", env: "—" },
                      { ghl: "LB — Merchant Welcome (WF6)", platform: "3. Fast Approval — Application Completion", trigger: "Deal closed won", env: "—" },
                      { ghl: "LB — Go-Live & Approval (WF7)", platform: "Set in Replit Secrets (env var)", trigger: "Merchant approved by underwriting", env: "GHL_WORKFLOW_MERCHANT_APPROVED" },
                      { ghl: "LB — Retention & NPS (WF8)", platform: "Merchant Retention — NPS", trigger: "Day 32 post-go-live", env: "—" },
                      { ghl: "LB — Win-Back (WF9)", platform: "Merchant Win-Back", trigger: "Account cancelled / ported", env: "—" },
                      { ghl: "LB — Re-engagement", platform: "19. Reactivation — Cold Lead Revival", trigger: "Cold lead re-engages after 90+ days", env: "—" },
                      { ghl: "LB — Merchant Application", platform: "Application form trigger", trigger: "Merchant completes application", env: "GHL_WORKFLOW_MERCHANT_APP" },
                      { ghl: "LB — Partner Welcome", platform: "Partner onboarding trigger", trigger: "Partner approved", env: "GHL_WORKFLOW_PARTNER_WELCOME" },
                    ].map((row) => (
                      <tr key={row.ghl} className="border-b hover:bg-muted/20">
                        <td className="p-3 font-medium">{row.ghl}</td>
                        <td className="p-3 font-mono text-muted-foreground text-[11px]">{row.platform}</td>
                        <td className="p-3 text-muted-foreground">{row.trigger}</td>
                        <td className="p-3 font-mono text-[11px]">{row.env !== "—" ? <Badge variant="outline" className="text-[10px]">{row.env}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card className="border-dashed">
              <CardContent className="pt-4 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-sm font-medium">Everything built? Register your Workflow IDs.</p>
                  <p className="text-xs text-muted-foreground mt-1">Copy each GHL Workflow ID (Automations → your workflow → Settings → Workflow ID) and paste it into the platform.</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button asChild size="sm" data-testid="btn-ghl-workflows-registry">
                    <Link href="/dashboard/ghl-workflows"><Settings className="h-4 w-4 mr-1.5" /> GHL Workflow Registry</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" data-testid="btn-open-ghl-mt">
                    <a href="https://app.gohighlevel.com" target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4 mr-1.5" /> Open GHL</a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── AI EMPLOYEE ─────────────────────────────────────────────────────── */}
        <TabsContent value="ai-employee" className="mt-4">
          <AiEmployeeTab />
        </TabsContent>

        {/* ── EMAIL SIGNATURES ─────────────────────────────────────────────── */}
        <TabsContent value="signatures" className="mt-4">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Mail className="h-5 w-5 text-blue-500" /> Email Signature Templates
                </CardTitle>
                <CardDescription>
                  Copy-paste ready signatures for Gmail, Outlook, GHL email templates, and SMS. Use the right format for each channel — never paste HTML into a plain text field.
                </CardDescription>
              </CardHeader>
            </Card>

            {/* Plain Text */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge className="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">Plain Text</Badge>
                    Primary Email Signature
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">Gmail · Outlook · Apple Mail · GHL plain email</span>
                </div>
                <CardDescription className="text-xs">Use this as your default signature in Gmail and Outlook. Settings → General → Signature → paste below.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CopyBlock label="Primary Signature — Plain Text" text={`Scott Allen
Business Development | Liberty Bancard
────────────────────────────────
📞 Direct:  (888) 555-0100
📧 Email:   scott@libertybancard.com
🌐 Website: www.libertybancard.com
📅 Book:    calendly.com/libertybancard

Save money on credit card processing.
Free statement analysis — results in 24 hours.
────────────────────────────────
Eligibility, underwriting, and card brand rules apply.
This email and any attachments are confidential. If received in error, please delete and notify us.`} />
                <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2">
                  <span className="font-medium">Gmail setup:</span> Settings (gear) → See all settings → General → Signature → + Create new → paste above → Save Changes
                </div>
              </CardContent>
            </Card>

            {/* Short / Mobile */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">Short</Badge>
                    Mobile / Reply Signature
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">SMS follow-ups · Quick replies · Mobile app</span>
                </div>
                <CardDescription className="text-xs">Use for replies and SMS-like contexts where brevity is important.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CopyBlock label="Short Signature — Reply / Mobile" text={`— Scott Allen | Liberty Bancard
(888) 555-0100 | scott@libertybancard.com
www.libertybancard.com`} />
                <CopyBlock label="Ultra Short — SMS Sender ID" text={`Scott Allen, Liberty Bancard · (888) 555-0100`} />
              </CardContent>
            </Card>

            {/* Formal / Letter */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">Formal</Badge>
                    Proposal / Letter Closing
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">Proposals · Partner letters · Merchant agreements</span>
                </div>
                <CardDescription className="text-xs">Use on proposals, formal follow-ups, and partner welcome letters.</CardDescription>
              </CardHeader>
              <CardContent>
                <CopyBlock label="Formal Closing Block" text={`Respectfully,

Scott Allen
Business Development Representative
Liberty Bancard | Payment Processing Solutions

Direct Line:  (888) 555-0100
Email:        scott@libertybancard.com
Website:      www.libertybancard.com
Schedule:     calendly.com/libertybancard

Liberty Bancard | 123 Main Street | Fort Lauderdale, FL 33301

Eligibility, underwriting, and card brand rules apply. This communication is intended for the
named recipient only and may contain proprietary information. If received in error, please
notify us immediately and delete this message.`} />
              </CardContent>
            </Card>

            {/* HTML Signature */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">HTML</Badge>
                    Rich HTML Email Signature
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">Gmail HTML mode · Outlook HTML · GHL rich email templates</span>
                </div>
                <CardDescription className="text-xs">Paste into Gmail's signature editor while in <strong>HTML source mode</strong>, or into GHL email template HTML editor. Renders with Liberty Bancard branding and navy color scheme.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CopyBlock label="HTML Signature — paste into Gmail source / GHL HTML editor" text={`<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333333;line-height:1.5;">
  <tr>
    <td style="padding-right:16px;vertical-align:top;border-right:3px solid #1e3a5f;">
      <div style="font-size:16px;font-weight:bold;color:#1e3a5f;white-space:nowrap;">Scott Allen</div>
      <div style="font-size:12px;color:#555555;margin-top:2px;">Business Development</div>
      <div style="font-size:12px;font-weight:bold;color:#1e3a5f;margin-top:1px;">LIBERTY BANCARD</div>
    </td>
    <td style="padding-left:16px;vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding-bottom:3px;">
            <span style="color:#1e3a5f;font-weight:bold;">&#128222;</span>&nbsp;
            <a href="tel:8885550100" style="color:#333333;text-decoration:none;">(888) 555-0100</a>
          </td>
        </tr>
        <tr>
          <td style="padding-bottom:3px;">
            <span style="color:#1e3a5f;font-weight:bold;">&#9993;</span>&nbsp;
            <a href="mailto:scott@libertybancard.com" style="color:#1e3a5f;text-decoration:none;">scott@libertybancard.com</a>
          </td>
        </tr>
        <tr>
          <td style="padding-bottom:3px;">
            <span style="color:#1e3a5f;font-weight:bold;">&#127760;</span>&nbsp;
            <a href="https://www.libertybancard.com" style="color:#1e3a5f;text-decoration:none;">www.libertybancard.com</a>
          </td>
        </tr>
        <tr>
          <td>
            <span style="color:#1e3a5f;font-weight:bold;">&#128197;</span>&nbsp;
            <a href="https://calendly.com/libertybancard" style="color:#1e3a5f;text-decoration:none;">Book a free analysis</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding-top:10px;border-top:1px solid #e5e7eb;margin-top:10px;">
      <span style="font-size:10px;color:#999999;">
        Eligibility, underwriting, and card brand rules apply.
        This email is confidential. If received in error, please delete and notify the sender.
      </span>
    </td>
  </tr>
</table>`} />
                <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2 space-y-1">
                  <p className="font-medium">Gmail HTML signature setup:</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>Settings → See all settings → General → Signature → + Create new</li>
                    <li>Click the <strong>&lt;&gt; source</strong> icon in the signature editor toolbar</li>
                    <li>Delete all existing content and paste the HTML above</li>
                    <li>Click <strong>&lt;&gt;</strong> again to switch back — preview your signature</li>
                    <li>Set as default for New emails and Replies → Save Changes</li>
                  </ol>
                </div>
              </CardContent>
            </Card>

            {/* GHL Email Footer */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">GHL</Badge>
                    GHL Email Template Footer
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">GHL Marketing → Email Templates → every template</span>
                </div>
                <CardDescription className="text-xs">Paste this footer at the bottom of every GHL email template you create. Includes unsubscribe variable and compliance language required for commercial email.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CopyBlock label="GHL Email Footer — paste at bottom of every template" text={`---

Scott Allen | Liberty Bancard
📞 (888) 555-0100 | scott@libertybancard.com | www.libertybancard.com

Eligibility, underwriting, and card brand rules apply. Not all businesses qualify.

You're receiving this because you expressed interest in merchant payment services or submitted a request through our website. To stop receiving emails, click here: {{contact.unsubscribe_url}}`} />
                <CopyBlock label="GHL Email Footer — HTML version (richer format)" text={`<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:11px;color:#888888;line-height:1.6;">
  <strong style="color:#1e3a5f;font-size:12px;">Scott Allen</strong> &bull; Liberty Bancard<br/>
  <a href="tel:8885550100" style="color:#888888;text-decoration:none;">(888) 555-0100</a>
  &bull;
  <a href="mailto:scott@libertybancard.com" style="color:#888888;text-decoration:none;">scott@libertybancard.com</a>
  &bull;
  <a href="https://www.libertybancard.com" style="color:#888888;text-decoration:none;">www.libertybancard.com</a>
  <br/><br/>
  Eligibility, underwriting, and card brand rules apply. Not all businesses qualify.
  <br/>
  You're receiving this because you expressed interest in merchant payment services.
  <a href="{{contact.unsubscribe_url}}" style="color:#888888;">Unsubscribe</a>
</div>`} />
                <div className="text-xs text-muted-foreground bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-2">
                  <span className="font-medium text-amber-700 dark:text-amber-300">GHL variable note:</span>
                  <span className="text-amber-700 dark:text-amber-400"> <code>{"{{contact.unsubscribe_url}}"}</code> is auto-filled by GHL when the email is sent. It adds a legally compliant unsubscribe link to every email — required for CAN-SPAM compliance. Do not remove it.</span>
                </div>
              </CardContent>
            </Card>

            {/* SMS Sign-offs */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge className="bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">SMS</Badge>
                    SMS Sender Sign-Offs
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">Append to first SMS in any sequence or manual outreach</span>
                </div>
                <CardDescription className="text-xs">GHL auto-handles STOP/UNSUBSCRIBE. These are conversational sign-offs for outbound SMS. Always include the opt-out notice on the first message to a contact.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CopyBlock label="First-touch SMS — must include opt-out notice" text={`— Scott Allen, Liberty Bancard (888) 555-0100. Reply STOP to opt out.`} />
                <CopyBlock label="Follow-up SMS — shorter (opt-out already given)" text={`— Scott, Liberty Bancard · (888) 555-0100`} />
                <CopyBlock label="Cold outbound first SMS — full identity + opt-out" text={`This is Scott Allen from Liberty Bancard. We help businesses like yours lower payment processing costs — often by $400–$800/month. Worth a quick look? Reply YES and I'll send details. Reply STOP to opt out.`} />
              </CardContent>
            </Card>

            {/* Quick Reference Card */}
            <Card className="border-dashed">
              <CardContent className="pt-4">
                <p className="text-sm font-semibold mb-3">Which signature to use where?</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="text-left p-2 font-medium">Channel / Use Case</th>
                        <th className="text-left p-2 font-medium">Signature to Use</th>
                        <th className="text-left p-2 font-medium">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { channel: "Gmail / Outlook — new email", sig: "Plain Text or HTML", note: "Set HTML as default; Gmail will render it correctly" },
                        { channel: "Gmail / Outlook — reply", sig: "Short / Reply", note: "Long signature on replies looks cluttered" },
                        { channel: "GHL email template", sig: "GHL Footer (HTML)", note: "Add to every template — includes unsubscribe URL variable" },
                        { channel: "GHL AI Employee emails", sig: "GHL Footer (plain)", note: "AI Employee may not render HTML — use plain text footer" },
                        { channel: "SMS (first touch)", sig: "First-touch SMS sign-off", note: "CAN-SPAM/TCPA: opt-out notice required on first message" },
                        { channel: "SMS (follow-up)", sig: "Short SMS sign-off", note: "Keep it brief — opt-out already given" },
                        { channel: "Proposals / Letters", sig: "Formal Closing Block", note: "Use for proposals, merchant agreements, partner letters" },
                        { channel: "Partner welcome emails", sig: "Formal or HTML", note: "High-touch — use the polished version" },
                      ].map((row) => (
                        <tr key={row.channel} className="border-b hover:bg-muted/20">
                          <td className="p-2 font-medium">{row.channel}</td>
                          <td className="p-2"><Badge variant="outline" className="text-xs">{row.sig}</Badge></td>
                          <td className="p-2 text-muted-foreground">{row.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="workflow-guard" className="mt-4 space-y-4" data-testid="tab-content-workflow-guard">
          <Card className="border-amber-300 dark:border-amber-700">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🛡️</span>
                <div>
                  <CardTitle className="text-base text-amber-900 dark:text-amber-200">Workflow Guard Contract</CardTitle>
                  <CardDescription className="text-amber-700 dark:text-amber-400 text-xs mt-0.5">
                    Required reading before building any GHL workflow that sends outbound messages. GHL workflows that skip this gate violate the Liberty Bancard contactability policy.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-md p-3">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">The Core Rule</p>
                <p className="text-sm text-amber-800 dark:text-amber-300 mt-1">
                  <strong>Replit is the system-of-record for all outbound permission decisions.</strong> GHL workflows must check Replit's permission gate before sending any automated email, SMS, voice call, or voicemail drop. GHL cannot override Replit's <code>doNotContact</code>, <code>consentTier</code>, or <code>lifecycleStage</code> fields.
                </p>
              </div>

              <div className="bg-muted/40 border rounded-md p-3 space-y-2">
                <p className="text-sm font-semibold">Two ways to gate a GHL workflow — choose one:</p>
                <div className="grid md:grid-cols-2 gap-3 text-xs">
                  <div className="bg-background border rounded p-2 space-y-1">
                    <p className="font-semibold text-green-700 dark:text-green-400">Option A — Endpoint check (recommended)</p>
                    <p className="text-muted-foreground">POST to <code>/api/ghl/permission-check</code> and branch on <code>{"{{webhookResponse.allowed}}"}</code>. Real-time, always current, zero field lag.</p>
                  </div>
                  <div className="bg-background border rounded p-2 space-y-1">
                    <p className="font-semibold text-blue-700 dark:text-blue-400">Option B — Field branch (simpler setup)</p>
                    <p className="text-muted-foreground">Branch on <code>lb_can_email</code>, <code>lb_can_sms</code>, etc. directly in GHL contact data. Requires lb_* custom fields to be created in GHL first (see follow-up task #616).</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Both options require the lb_* custom fields to be created in GHL Location Settings before they carry accurate data. Use Option A for the highest assurance — it always reflects the live Replit state.</p>
              </div>

              <div className="space-y-3">
                <p className="text-sm font-semibold">Step-by-Step: Option A — Endpoint check</p>
                <ol className="space-y-3 text-sm">
                  <li className="flex gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 flex items-center justify-center text-xs font-bold">1</span>
                    <div>
                      <p className="font-medium">Add a "Webhook" action at the start of every workflow</p>
                      <p className="text-muted-foreground text-xs mt-0.5">Before any send action (email, SMS, call), add a <strong>Custom Webhook</strong> action that POSTs to:</p>
                      <code className="block bg-muted px-2 py-1 rounded text-xs mt-1 select-all">
                        {"POST https://<your-replit-app>.replit.app/api/ghl/permission-check"}
                      </code>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 flex items-center justify-center text-xs font-bold">2</span>
                    <div>
                      <p className="font-medium">Set the Authorization header</p>
                      <p className="text-muted-foreground text-xs mt-0.5">In GHL Custom Webhook headers, add:</p>
                      <code className="block bg-muted px-2 py-1 rounded text-xs mt-1">
                        Authorization: Bearer {"<GHL_WEBHOOK_SECRET value>"}
                      </code>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 flex items-center justify-center text-xs font-bold">3</span>
                    <div>
                      <p className="font-medium">Set the request body</p>
                      <code className="block bg-muted px-2 py-1 rounded text-xs mt-1 whitespace-pre">
{`{
  "ghlContactId": "{{contact.id}}",
  "channel": "email"
}`}
                      </code>
                      <p className="text-muted-foreground text-xs mt-1">Use <code>channel: "sms"</code>, <code>"voice_ai"</code>, or <code>"ringless_vm"</code> as appropriate for the workflow.</p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 flex items-center justify-center text-xs font-bold">4</span>
                    <div>
                      <p className="font-medium">Add a conditional branch on the response</p>
                      <p className="text-muted-foreground text-xs mt-0.5">The endpoint always returns HTTP 200. Check the <code>allowed</code> field in the response body:</p>
                      <div className="mt-1 space-y-1 text-xs">
                        <div className="flex items-start gap-2">
                          <span className="text-green-600 font-semibold mt-0.5">✓ IF</span>
                          <span><code>{"{{webhookResponse.allowed}}"} = true</code> → proceed to send action</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-red-600 font-semibold mt-0.5">✗ IF</span>
                          <span><code>{"{{webhookResponse.allowed}}"} = false</code> → end workflow / skip contact</span>
                        </div>
                      </div>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 flex items-center justify-center text-xs font-bold">5</span>
                    <div>
                      <p className="font-medium">Log the block reason (optional but recommended)</p>
                      <p className="text-muted-foreground text-xs mt-0.5">When <code>allowed = false</code>, <code>{"{{webhookResponse.reason}}"}</code> contains the block reason (e.g. <code>dnc</code>, <code>tier_insufficient</code>, <code>contact_not_found</code>). Add a GHL note or internal tag to aid debugging.</p>
                    </div>
                  </li>
                </ol>
              </div>

              <div className="border rounded-md overflow-hidden">
                <div className="bg-muted px-3 py-2 text-xs font-semibold">Possible <code>reason</code> values</div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left px-3 py-2 font-medium">Reason</th>
                      <th className="text-left px-3 py-2 font-medium">Meaning</th>
                      <th className="text-left px-3 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { reason: "permitted", meaning: "Contact is fully contactable on this channel", action: "Proceed with send" },
                      { reason: "dnc", meaning: "Contact is marked Do Not Contact", action: "End workflow — do not send" },
                      { reason: "tier_insufficient", meaning: "Consent tier does not allow this channel", action: "End workflow — do not send" },
                      { reason: "channel_disabled", meaning: "Channel blocked (e.g. SMS status = stop)", action: "End workflow for this channel" },
                      { reason: "contact_not_found", meaning: "GHL contact not yet linked to Replit", action: "Trigger a sync and retry, or end" },
                      { reason: "configuration_missing", meaning: "GHL_WEBHOOK_SECRET not set — endpoint returns 401", action: "Contact admin — all checks disabled" },
                      { reason: "unauthorized", meaning: "Bearer token mismatch — endpoint returns 401", action: "Fix the Authorization header in GHL" },
                      { reason: "bad_request", meaning: "Missing ghlContactId/email or invalid channel — endpoint returns 400", action: "Fix the request body in GHL Custom Webhook" },
                      { reason: "internal_error", meaning: "Replit returned an error (endpoint returns 200)", action: "Check Operator Dashboard logs" },
                    ].map(row => (
                      <tr key={row.reason} className="border-b hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono text-xs">{row.reason}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.meaning}</td>
                        <td className="px-3 py-2">{row.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-md p-3 space-y-1">
                <p className="text-sm font-semibold text-red-800 dark:text-red-200">Kill Lines — These rules MUST be honoured</p>
                <ul className="text-xs text-red-700 dark:text-red-300 space-y-1 list-disc ml-4">
                  <li>Any GHL workflow that sends automated messages without checking the permission gate bypasses contactability — this is a <strong>regulatory violation</strong>.</li>
                  <li><strong>Manual call tasks:</strong> Manual call tasks do not require PEWC, SMS consent, AI voice consent, or RVM consent. However, GHL-native workflows that create manual call tasks <em>must still</em> check <code>lb_can_manual_call === "true"</code> or call <code>/api/ghl/permission-check</code> with <code>channel="manual_call"</code> so DNC/doNotContact/opted_out contacts are never assigned follow-up call tasks.</li>
                  <li>GHL's native DND / email unsubscribe events are automatically relayed to Replit via webhook. Do NOT re-enable contacts from within GHL after they have opted out.</li>
                  <li>Never use GHL's built-in "Mark DND Off" action — all DNC changes must flow through Replit's contact update API to be properly logged and audited.</li>
                  <li>The <code>lb_do_not_contact</code>, <code>lb_consent_tier</code>, and <code>lb_can_*</code> custom fields in GHL are read-only from the GHL side — written by Replit's sync engine. Never manually edit them in GHL.</li>
                </ul>
              </div>

              <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2">
                <strong>Monitoring:</strong> Permission check call counts and opt-out events are visible on the GHL Settings page under "Sync Authority Guard". A <code>fieldWriteErrors422</code> count &gt; 0 means the lb_* custom fields haven't been created in GHL yet — visit GHL → Settings → Custom Fields to create them.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>
    </div>
  );
}
