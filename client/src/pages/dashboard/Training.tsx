import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { ResourcesNav } from "@/components/dashboard/ResourcesNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useC4RetainedSelection } from "@/hooks/use-c4-retained-selection";
import { trainingViews } from "@/lib/crm-destination-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  BookOpen,
  Loader2,
  Target,
  FileText,
  Users,
  TrendingUp,
  CheckCircle,
  Rocket,
  Brain,
  Send,
  History,
  Star,
  Trophy,
  ChevronRight,
  Play,
  RotateCcw,
  MessageSquare,
  User,
  Bot,
  ClipboardList,
  ArrowLeft,
  Copy,
  Check,
  Quote,
  AlertCircle,
  Lightbulb,
  BookMarked,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ── Training content ─────────────────────────────────────────────────────────

interface TrainingModule {
  key: string;
  name: string;
  icon: React.ElementType;
  colorClass: string;
  accentBg: string;
  description: string;
  readMins: number;
  content: string;
}

const TRAINING_MODULES: TrainingModule[] = [
  {
    key: "prospecting",
    name: "Prospecting",
    icon: Target,
    colorClass: "text-blue-600 dark:text-blue-400",
    accentBg: "bg-blue-500/10",
    description: "Find and qualify merchants by vertical, lead sources, cold call openers, LinkedIn, and door-to-door tactics.",
    readMins: 6,
    content: `PROSPECTING GUIDE
==================

HOW TO FIND AND QUALIFY MERCHANTS

1. TARGET VERTICALS
-------------------
Focus on high-volume, card-heavy businesses:
- Medical / Dental / Medspa (high average ticket, low chargeback)
- Automotive (service centers, dealers)
- Restaurants (high volume, open to 0% surcharge)
- Home Services (HVAC, plumbing, electric)
- Retail (boutiques, hardware, specialty)

2. LEAD SOURCES
---------------
- Cold calling from Google Maps / Yelp searches by category + city
- Sunbiz entity searches (Florida) — sort by new registrations
- LinkedIn Sales Navigator — filter by employee count 5-50, industry
- Door-to-door in commercial strips and plazas
- Chamber of Commerce member directories
- Referrals from existing merchants

3. COLD CALL OPENERS
--------------------
"Hi, this is [Name] from Liberty Bancard. We help [vertical] businesses eliminate credit card processing fees entirely — I wanted to take 30 seconds to see if that's something worth a quick conversation."

Pattern interrupt opener:
"I know you probably get a hundred of these calls — but I promise this one is different. We have merchants just like you saving $800–$2,000 a month. Can I ask what you're currently paying?"

4. LINKEDIN OUTREACH
--------------------
"Hi [Name], I work with [vertical] businesses in [city] on eliminating credit card processing costs. Would it be worth 10 minutes to show you how it works? No pressure, just a quick numbers conversation."

Connect first, then message after 3 days if they accept.

5. DOOR-TO-DOOR APPROACH
------------------------
- Target strip malls, plazas, commercial corridors
- Best times: Tue–Thu, 10am–12pm and 2pm–4pm (avoid lunch rush)
- Lead with: "We work with several businesses on this block — mind if I grab 2 minutes to show you what they're saving?"
- Drop a one-pager if owner isn't available; follow up by phone next day

6. QUALIFYING QUESTIONS
-----------------------
- "What credit card processor do you use right now?"
- "Roughly how much per month do you pay in processing fees?"
- "What's your average ticket size?"
- "Do you process mostly debit, credit, or a mix?"
- "Have you heard of the dual pricing / cash discount program?"

Qualified lead criteria:
✓ Processing $10K+/month
✓ Open to a quick statement review
✓ Decision maker is accessible
✓ Not locked in a long-term contract with heavy ETF`,
  },
  {
    key: "how-to-sell",
    name: "How to Sell",
    icon: TrendingUp,
    colorClass: "text-green-600 dark:text-green-400",
    accentBg: "bg-green-500/10",
    description: "Value proposition scripts, objection handling, dual pricing pitch, pain point identification, and high-risk merchant approach.",
    readMins: 8,
    content: `HOW TO SELL — SCRIPTS & OBJECTION HANDLING
==========================================

1. CORE VALUE PROPOSITION
--------------------------
Liberty Bancard gives merchants two powerful options:
A) 0% / Dual Pricing Program — pass processing fees to card users, merchants pay $0 in fees
B) Wholesale / Interchange-Plus — lowest possible cost structure, full transparency, no bundled pricing tricks

Open with: "We help businesses stop giving away 2–4% of every sale to their processor. Most of our merchants either pay nothing at all, or cut their rate in half."

2. PAIN POINT IDENTIFICATION
-----------------------------
Ask open-ended questions:
- "What do you find most frustrating about your current processor?"
- "Do you feel like you know exactly what you're paying and why?"
- "Has your rate gone up in the last year without explanation?"
- "Do you get hit with extra fees at the end of each month?"

Listen for: hidden fees, rate increases, poor service, locked contracts, not understanding their bill.

3. DUAL PRICING / 0% PITCH
---------------------------
"The 0% program works like this: instead of you absorbing the processing fee, it's split between cash and card prices — exactly like a gas station. Card customers pay a small service fee (typically 3.5%), cash customers get a discount. You collect the same amount either way — the fee just disappears from your P&L."

Key proof point: "Over 80% of consumers say they would still pay by card even with a small fee — and many prefer it over carrying cash."

4. HIGH-RISK PITCH
------------------
For merchants declined elsewhere:
"We work with high-risk categories that traditional banks won't touch. Whether that's nutraceuticals, CBD, firearms, or high-ticket online sales — we have underwriting relationships that can get you approved."

5. OBJECTION HANDLING
----------------------

Objection: "We've been with our processor for years."
Response: "That loyalty is great — I'm just asking for 5 minutes to show you what you're actually paying vs. what's possible. You can always say no."

Objection: "I don't want to pass fees to my customers."
Response: "Completely fair. In that case, we can look at our wholesale program — you'd still likely cut your current rate by 30–50% without changing anything for your customers."

Objection: "I'm locked in a contract."
Response: "Let's look at your statement first. If the savings are big enough, breaking a contract almost always makes sense financially — and sometimes ETFs are negotiable."

Objection: "I need to talk to my partner."
Response: "Of course. Would it help if I put together a short savings analysis you two could review together? Takes me about 10 minutes."

6. CLOSING SETUP
-----------------
After identifying pain points:
"Based on what you've told me, I think there's a real opportunity here. Can I get a recent processing statement — just the last 1–2 months? I'll do a free analysis and come back with exact numbers. No obligation."`,
  },
  {
    key: "statement-review",
    name: "Statement Review",
    icon: FileText,
    colorClass: "text-purple-600 dark:text-purple-400",
    accentBg: "bg-purple-500/10",
    description: "Step-by-step guide to reading a merchant processing statement, calculating effective rate, and building the savings case.",
    readMins: 7,
    content: `STATEMENT REVIEW GUIDE
======================

STEP-BY-STEP GUIDE TO READING A MERCHANT PROCESSING STATEMENT

1. WHAT YOU'RE LOOKING FOR
---------------------------
Goal: Calculate the merchant's effective rate and identify savings opportunities.

Effective Rate = Total Fees Paid ÷ Total Volume Processed × 100

Example: $1,200 in fees on $45,000 in volume = 2.67% effective rate

2. KEY LINE ITEMS TO FIND
--------------------------
Look for these sections on any statement:

a) PROCESSING VOLUME
   - "Total Sales Volume" or "Gross Sales"
   - Should match their POS or bank deposits

b) INTERCHANGE FEES
   - The actual cost the card networks charge (Visa/MC/Amex)
   - Typically listed as a % + per-transaction rate

c) PROCESSOR MARKUP
   - This is what goes to your competitor — the profit layer on top
   - Look for: "Service Fee," "Margin," "Markup," "Assessment"

d) MONTHLY FEES
   - Statement fee ($10–$25/mo) — often unnecessary
   - PCI compliance fee ($30–$120/yr) — check if merchant is actually compliant
   - Gateway fee — if they use a separate payment gateway
   - Minimum monthly fee — charged if volume is low

e) OTHER RED FLAGS
   - Non-qualified surcharges (NQS) — sign of tiered pricing abuse
   - Batch fees — per-batch settlement charges
   - Annual fee — often hidden
   - Paper statement fee — easy win to eliminate

3. TIERED vs. INTERCHANGE-PLUS
--------------------------------
TIERED PRICING (bad for merchant):
- Qualified / Mid-Qualified / Non-Qualified tiers
- Processor picks which tier to assign transactions
- Creates hidden markup; non-qual rate often 3.5–4%+
- Sign: no interchange line items, just tier percentages

INTERCHANGE-PLUS (good for merchant):
- Shows exact interchange cost for each card type
- Processor markup is clearly stated separately
- Fully transparent; easy to compare

Most competitors use tiered — this is your main talking point.

4. BUILDING THE SAVINGS CASE
------------------------------
Step 1: Calculate current effective rate
Step 2: Estimate what they'd pay on Liberty's wholesale program — typical wholesale markup: 0.10% + $0.05–0.08/transaction — add average interchange cost for their vertical
Step 3: Show monthly and annual savings

Example Savings Case:
Current:    $45,000/mo × 2.67% = $1,201/mo
Liberty:    $45,000/mo × 1.45% = $652/mo
Savings:    $549/mo = $6,588/year

Step 4: If eligible for 0% — show zero-fee scenario with card price adjustment

5. COMMON STATEMENT FORMATS
-----------------------------
- Fiserv/First Data: Look for "Interchange Summary" section
- TSYS/Global Payments: Tiered pricing breakdown on page 2–3
- Square/Stripe: Simple flat-rate, usually 2.6–2.9% + 30¢ (Square/Stripe users are easiest to convert — show the math clearly)
- Heartland: Often interchange-plus but with high markup

6. WHAT TO BRING BACK TO THE MERCHANT
---------------------------------------
Prepare a one-page savings proposal showing:
- Their current effective rate
- Projected rate on Liberty program
- Monthly savings
- Annual savings
- Break-even on any transition costs (if applicable)`,
  },
  {
    key: "closing",
    name: "Closing",
    icon: CheckCircle,
    colorClass: "text-orange-600 dark:text-orange-400",
    accentBg: "bg-orange-500/10",
    description: "Closing scripts, trial closes, urgency triggers, handling stalls, the assumptive close, and follow-up cadence.",
    readMins: 7,
    content: `CLOSING GUIDE
=============

CLOSING SCRIPTS, URGENCY TRIGGERS & FOLLOW-UP CADENCE

1. TRIAL CLOSES (USE THROUGHOUT THE CONVERSATION)
---------------------------------------------------
Trial closes test commitment before the final ask.

"If the numbers make sense, is there any reason you wouldn't want to move forward?"

"Based on everything we've talked about, does this sound like something that could work for your business?"

"If I can show you saving $600/month with no disruption to your operations, what would you need to make a decision?"

2. THE SAVINGS CLOSE
---------------------
After presenting the analysis:
"You're currently paying $1,200/month in fees. On our program, you'd pay roughly $650 — that's $550 back in your pocket every month, or $6,600 a year. I can get your new terminal programmed and set up within a week. Want to get the paperwork started today?"

3. THE URGENCY CLOSE
---------------------
"Our current pricing promotion ends [date]. If we can get your application in this week, you'd lock in the lowest available rate."

"Interchange rates just went up across the board — the sooner we lock in your wholesale rate, the more you save before the next adjustment."

4. WHEN THEY STALL
-------------------

Objection: "I want to think about it."
Response: "Absolutely. What's the one thing that's holding you back? Let me address that right now so you can think about it with all the information."

Objection: "I need to compare other options."
Response: "That makes sense. Here's what I'd suggest: let me send you our comparison sheet. Most merchants who compare find we're lowest — but if you find better, I'll match it or tell you honestly that you should go with them."

Objection: "I'm happy with what I have."
Response: "I respect that. Can I ask — when did you last have someone actually audit your rate? Most merchants we find are paying 2–3% more than they need to. Five minutes — just let me show you the math."

5. THE ASSUMPTIVE CLOSE
------------------------
Stop asking "do you want to move forward?" — assume they do.

"Let me grab your application. What's the legal business name on your license?"

"I'll get your terminal shipped overnight. What's the delivery address?"

"Since we're going with the 0% program — do you have a voided check handy or do you want to send your banking info electronically?"

6. FOLLOW-UP CADENCE AFTER DEMO
---------------------------------
Day 0: Send savings summary + one-pager via email
Day 1: Text: "Did you get a chance to look at the proposal I sent over?"
Day 3: Call: "Just following up on the analysis. Any questions come up?"
Day 7: Email: "Checking back in — the proposal is still on the table."
Day 14: Call with new angle: "One of our restaurants in [city] just saved $900/month — made me think of you."
Day 30: Final check-in: "I want to make sure I haven't dropped the ball. Is this still something you'd like to revisit?"

7. WHAT NOT TO DO
------------------
✗ Don't chase more than 5–6 times without a response — move on
✗ Don't negotiate rate before the application is submitted
✗ Don't promise approval — underwriting makes that call
✗ Don't skip the trial close — always gauge commitment before the final ask`,
  },
  {
    key: "onboarding",
    name: "Onboarding & Compliance",
    icon: Users,
    colorClass: "text-teal-600 dark:text-teal-400",
    accentBg: "bg-teal-500/10",
    description: "What happens after signing, setting merchant expectations, PCI compliance basics, and chargeback prevention.",
    readMins: 7,
    content: `ONBOARDING & COMPLIANCE GUIDE
==============================

WHAT HAPPENS AFTER SIGNING

1. THE ONBOARDING PROCESS
--------------------------
After the merchant signs the application, the following steps occur:

Step 1 — Document Collection (Day 1–2)
- Signed merchant application
- Voided check (for ACH/deposit setup)
- Copy of government-issued photo ID (owner/signer)
- 3 months of processing statements (if applicable)
- Business license (if required by vertical or volume)

Step 2 — Underwriting Submission (Day 2–3)
- Application submitted to underwriting
- Risk team reviews: credit, volume history, vertical, chargeback rate
- High-risk verticals may require additional documentation

Step 3 — Approval & Setup (Day 3–7)
- Merchant ID (MID) assigned
- Terminal or gateway programmed and shipped
- Test transaction run to confirm setup

Step 4 — Go-Live (Day 7–14)
- Terminal delivered and activated
- First batch processed
- Confirm deposit lands in merchant's bank account

2. MERCHANT EXPECTATIONS (SET THESE UPFRONT)
---------------------------------------------
Be transparent about:
- Timing: "Expect 5–10 business days from application to live"
- Deposits: "Funds typically settle within 1–2 business days"
- Statements: "You'll receive a monthly statement via email/portal"
- Support: "For any issues, call/text me directly or use our support line"

3. PCI COMPLIANCE BASICS
-------------------------
PCI DSS (Payment Card Industry Data Security Standard) applies to ALL merchants.

Merchant levels:
- Level 4 (most small merchants): Self-Assessment Questionnaire (SAQ)
- Level 1–3: Full audit required (high volume)

Key PCI requirements for merchants:
- Never store full card numbers in any system
- Use a PCI-compliant terminal (EMV/chip)
- Complete annual SAQ (questionnaire)
- Scan network quarterly (if applicable)

PCI non-compliance fee: typically $20–$40/month charged by processor — help merchants get compliant to avoid this fee.

Common SAQ types:
- SAQ A: Card-not-present, fully outsourced (e-commerce)
- SAQ B: Imprinters or standalone dial-up terminals
- SAQ C-VT: Web-based virtual terminal, no electronic storage
- SAQ D: All other merchants

4. CHARGEBACK PREVENTION
-------------------------
Chargebacks occur when a customer disputes a transaction with their bank. High chargeback rates (>1%) trigger account reviews and possible termination.

Best practices to share with merchants:
- Always get a signed receipt for high-ticket sales
- Use AVS (Address Verification) for card-not-present
- Have a clear refund/return policy visible at point of sale
- Respond to all disputes within the deadline (typically 7–10 days)
- Document delivery confirmation for shipped goods
- Use clear billing descriptors (what shows on customer's statement)

5. WHAT AGENTS SHOULD DO AFTER GO-LIVE
----------------------------------------
- Check in at day 7: "Is everything working? First deposit come through?"
- Check in at day 30: "How's the new setup treating you?"
- Ask for a referral at 30-day mark when satisfaction is highest
- Flag any volume drops to the support team`,
  },
  {
    key: "quick-start",
    name: "Agent Quick-Start",
    icon: Rocket,
    colorClass: "text-rose-600 dark:text-rose-400",
    accentBg: "bg-rose-500/10",
    description: "Day-one orientation for new reps: systems access, first calls, compensation structure, residuals, and first-week checklist.",
    readMins: 8,
    content: `AGENT QUICK-START GUIDE
========================

DAY-ONE ORIENTATION FOR NEW REPS

1. SYSTEMS ACCESS
------------------
You'll need access to the following tools:

CRM (This System)
- Log in at your CRM URL
- Set up your profile and notification preferences
- Your manager will assign you a territory or lead queue

GoHighLevel (GHL)
- Used for email sequences, SMS campaigns, call tracking
- Ask your manager for login credentials
- Connect your GHL calendar for appointment booking

Google Workspace
- Company email: firstname@libertybancardteam.com
- Access to shared Drive folder for templates and collateral

Proposal Tool
- Built into the CRM under Statement Review
- Upload a merchant statement to generate a savings proposal in minutes

2. YOUR FIRST 5 CALLS
----------------------
Before making any calls, review:
✓ Prospecting Guide (what to say when calling cold)
✓ How to Sell Guide (value prop and objection handling)
✓ Statement Review Guide (so you can intelligently discuss their bill)

Your first calls should focus on:
- Introducing yourself and the company
- Asking qualifying questions
- NOT trying to close — your goal is to get a statement or book a follow-up

"Hi, this is [Name] with Liberty Bancard. We specialize in helping [vertical] businesses reduce their credit card processing costs. I'm not here to pitch you today — I just wanted to introduce myself and see if it's worth a 10-minute conversation about what you're currently paying. Would that be okay?"

3. COMPENSATION STRUCTURE
--------------------------
You earn residual income based on the merchants you bring on.

How it works:
- You earn a % of the gross profit generated by each merchant's processing
- Residuals are paid monthly, typically on the 15th
- The more volume your merchants process, the higher your monthly residual

Residual tiers (example structure):
- Months 1–3: 40% of gross profit
- Months 4–12: 50% of gross profit
- Month 13+: 60% of gross profit (loyalty bonus)

You also earn upfront bonuses for hitting merchant activation targets. Ask your manager for the current bonus schedule.

4. HOW RESIDUALS WORK
----------------------
Residuals are recurring monthly income from merchants you've signed.

Example:
- You sign a restaurant processing $50,000/month
- Liberty earns $300/month gross profit from that merchant
- You earn 50% = $150/month from that one merchant — forever, as long as they stay

After 12 months with 20 merchants averaging $150/residual each:
= $3,000/month in passive income, growing each month

Keys to growing residuals:
✓ Sign merchants with high volume (restaurants, auto, medical)
✓ Keep merchants happy so they stay (check in monthly)
✓ Ask for referrals from happy merchants
✓ Never stop prospecting — your book of business compounds

5. FIRST WEEK CHECKLIST
------------------------
Day 1:
☐ Complete system access setup
☐ Read all 6 training guides
☐ Shadow a senior rep on 2+ calls

Day 2:
☐ Make your first 10 cold calls
☐ Log all activity in the CRM

Day 3–5:
☐ Aim for 1 statement request or appointment booked
☐ Review a sample processing statement with your manager
☐ Complete your first savings proposal walkthrough

6. RESOURCES & SUPPORT
-----------------------
- Direct manager: Contact your assigned team lead
- Technical support: support@libertybancardteam.com
- Underwriting questions: Run all questions through your manager first
- Marketing materials: Available in the CRM Asset Library
- Competitive intel: Ask your manager for the latest compare sheets

Remember: The reps who succeed are the ones who dial consistently, follow up relentlessly, and genuinely help merchants understand their savings.`,
  },
];

// ── Content renderer ──────────────────────────────────────────────────────────

type LineType =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "section"; num: string; text: string }
  | { kind: "subsection"; letter: string; text: string }
  | { kind: "script"; text: string }
  | { kind: "objection"; text: string }
  | { kind: "response"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "check"; text: string; variant: "yes" | "no" | "todo" }
  | { kind: "day"; label: string; text: string }
  | { kind: "step"; text: string }
  | { kind: "example"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blank" };

function parseLine(line: string): LineType {
  const t = line.trim();
  if (!t) return { kind: "blank" };
  if (/^[=\-]{3,}$/.test(t)) return { kind: "blank" };

  // Numbered section header
  const numMatch = t.match(/^(\d+)\.\s+(.+)$/);
  if (numMatch) return { kind: "section", num: numMatch[1], text: numMatch[2] };

  // Lettered subsection: a) TITLE
  const letterMatch = t.match(/^([a-e])\)\s+(.+)$/);
  if (letterMatch) return { kind: "subsection", letter: letterMatch[1], text: letterMatch[2] };

  // All-caps title line (major heading)
  if (/^[A-Z][A-Z\s\-—&:\/\.]+$/.test(t) && t.length > 4 && !/^[A-Z]{1,3}$/.test(t)) {
    return { kind: "h2", text: t };
  }

  // Objection / Response pairs
  if (t.startsWith("Objection:")) return { kind: "objection", text: t.replace(/^Objection:\s*/, "") };
  if (t.startsWith("Response:") || t.startsWith("→")) return { kind: "response", text: t.replace(/^(Response:|→)\s*/, "") };

  // Bullet lists
  if (t.startsWith("- ")) return { kind: "bullet", text: t.slice(2) };
  if (t.startsWith("✓ ")) return { kind: "check", variant: "yes", text: t.slice(2) };
  if (t.startsWith("✗ ")) return { kind: "check", variant: "no", text: t.slice(2) };
  if (t.startsWith("☐ ")) return { kind: "check", variant: "todo", text: t.slice(2) };

  // Day N: ...
  const dayMatch = t.match(/^(Day \d[\d–\-]*):?\s+(.*)$/);
  if (dayMatch) return { kind: "day", label: dayMatch[1], text: dayMatch[2] };

  // Step N — ...
  const stepMatch = t.match(/^(Step \d[^—]*—)\s+(.*)$/);
  if (stepMatch) return { kind: "step", text: t };

  // Lines starting with a quote character — script
  if (t.startsWith('"')) return { kind: "script", text: t };

  // Example / formula lines
  if (/^(Example|Effective Rate|Current:|Liberty:|Savings:|Step \d|After \d+|= \$|A\)|B\)|How it works)/.test(t)) {
    return { kind: "example", text: t };
  }

  return { kind: "paragraph", text: t };
}

function groupLines(content: string): LineType[][] {
  const rawLines = content.split("\n");
  const parsed = rawLines.map(parseLine);

  // Group consecutive lines of compatible types into blocks
  const blocks: LineType[][] = [];
  let current: LineType[] = [];

  for (const line of parsed) {
    if (line.kind === "blank") {
      if (current.length > 0) { blocks.push(current); current = []; }
    } else {
      // Start a new block for headings
      if (["h1", "h2", "section", "subsection"].includes(line.kind) && current.length > 0) {
        blocks.push(current); current = [];
      }
      // Start a new block if transitioning between incompatible types
      if (current.length > 0) {
        const prevKind = current[current.length - 1].kind;
        const newKind = line.kind;
        const sameGroup = (a: string, b: string) => {
          if (a === b) return true;
          const bulletGroup = ["bullet", "check"];
          if (bulletGroup.includes(a) && bulletGroup.includes(b)) return true;
          return false;
        };
        if (!sameGroup(prevKind, newKind) && !["paragraph", "script", "example", "objection", "response", "day", "step"].includes(newKind)) {
          blocks.push(current); current = [];
        }
      }
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function ContentRenderer({ content }: { content: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const blocks = useMemo(() => groupLines(content), [content]);

  // Group consecutive objection+response pairs
  const elements: React.ReactNode[] = [];
  let bi = 0;

  while (bi < blocks.length) {
    const block = blocks[bi];
    const first = block[0];

    // h1 — skip the document title line (rendered in header)
    if (first.kind === "h1") { bi++; continue; }

    // h2 — sub-title
    if (first.kind === "h2") {
      elements.push(
        <p key={bi} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-6 mb-1 first:mt-0">
          {first.text}
        </p>
      );
      bi++; continue;
    }

    // numbered section header
    if (first.kind === "section") {
      elements.push(
        <div key={bi} className="flex items-baseline gap-2.5 mt-8 mb-3 first:mt-0">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
            {first.num}
          </span>
          <h3 className="text-base font-semibold text-foreground leading-tight">{first.text}</h3>
        </div>
      );
      bi++; continue;
    }

    // lettered subsection
    if (first.kind === "subsection") {
      elements.push(
        <div key={bi} className="flex items-baseline gap-2 mt-3 mb-1.5 ml-1">
          <span className="text-xs font-bold text-primary uppercase">{first.letter})</span>
          <h4 className="text-sm font-semibold text-foreground">{first.text}</h4>
        </div>
      );
      bi++; continue;
    }

    // objection + response — look ahead to pair them
    if (first.kind === "objection") {
      // Collect all lines in this block as objection/response pairs
      const pairs: { objection: string; response: string }[] = [];
      let li = 0;
      while (li < block.length) {
        const obj = block[li];
        if (obj.kind === "objection") {
          const resp = block[li + 1];
          pairs.push({
            objection: obj.text,
            response: resp?.kind === "response" ? resp.text : "",
          });
          li += resp?.kind === "response" ? 2 : 1;
        } else if (obj.kind === "response") {
          // Standalone response
          pairs.push({ objection: "", response: obj.text });
          li++;
        } else {
          li++;
        }
      }
      elements.push(
        <div key={bi} className="space-y-2.5 my-3">
          {pairs.map((pair, pi) => (
            <div key={pi} className="rounded-lg overflow-hidden border border-border">
              {pair.objection && (
                <div className="flex items-start gap-2.5 px-3.5 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-100 dark:border-amber-900/40">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-900 dark:text-amber-200 font-medium leading-snug">{pair.objection}</p>
                </div>
              )}
              {pair.response && (
                <div className="flex items-start gap-2.5 px-3.5 py-2.5 bg-muted/30">
                  <Lightbulb className="w-3.5 h-3.5 text-green-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-foreground leading-relaxed">{pair.response}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      );
      bi++; continue;
    }

    // script / quote blocks
    if (first.kind === "script") {
      const allScripts = block.filter(l => l.kind === "script") as { kind: "script"; text: string }[];
      const combinedText = allScripts.map(l => l.text).join("\n");
      const copyId = `script-${bi}`;
      elements.push(
        <div key={bi} className="relative group my-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 px-4 py-3.5">
          <Quote className="absolute top-3 left-3 w-3 h-3 text-blue-400 dark:text-blue-600" />
          <button
            onClick={() => copyText(combinedText.replace(/^"|"$/g, "").replace(/\n/g, " "), copyId)}
            className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-blue-100 dark:hover:bg-blue-900/40"
            title="Copy script"
          >
            {copiedId === copyId ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-blue-500" />
            )}
          </button>
          <div className="pl-4 space-y-1">
            {allScripts.map((l, si) => (
              <p key={si} className="text-sm italic text-blue-900 dark:text-blue-200 leading-relaxed">{l.text}</p>
            ))}
          </div>
        </div>
      );
      // Also render non-script lines in the same block
      const nonScripts = block.filter(l => l.kind !== "script");
      if (nonScripts.length > 0) {
        elements.push(
          <div key={`${bi}-rest`} className="space-y-1">
            {nonScripts.map((l, li) => (
              l.kind === "paragraph" ? (
                <p key={li} className="text-sm text-muted-foreground leading-relaxed">{(l as any).text}</p>
              ) : null
            ))}
          </div>
        );
      }
      bi++; continue;
    }

    // bullet / check lists
    if (block.every(l => l.kind === "bullet" || l.kind === "check")) {
      elements.push(
        <ul key={bi} className="space-y-1.5 my-2 ml-1">
          {block.map((l, li) => {
            if (l.kind === "bullet") {
              return (
                <li key={li} className="flex items-start gap-2.5 text-sm text-foreground">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                  <span className="leading-relaxed">{l.text}</span>
                </li>
              );
            }
            if (l.kind === "check") {
              const icon =
                l.variant === "yes" ? <Check className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" /> :
                l.variant === "no" ? <span className="text-red-500 text-xs font-bold shrink-0 mt-0.5">✗</span> :
                <span className="w-3.5 h-3.5 rounded border border-border bg-background shrink-0 mt-0.5 inline-block" />;
              return (
                <li key={li} className="flex items-start gap-2 text-sm text-foreground">
                  {icon}
                  <span className="leading-relaxed">{l.text}</span>
                </li>
              );
            }
            return null;
          })}
        </ul>
      );
      bi++; continue;
    }

    // day items (Day 0: ..., Day 1: ...)
    if (block.some(l => l.kind === "day")) {
      elements.push(
        <div key={bi} className="space-y-2 my-3">
          {block.map((l, li) => {
            if (l.kind === "day") {
              return (
                <div key={li} className="flex items-start gap-3">
                  <span className="shrink-0 text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded mt-0.5">{(l as any).label}</span>
                  <span className="text-sm text-foreground leading-relaxed">{(l as any).text}</span>
                </div>
              );
            }
            if (l.kind === "paragraph") {
              return <p key={li} className="text-sm text-muted-foreground leading-relaxed">{(l as any).text}</p>;
            }
            return null;
          })}
        </div>
      );
      bi++; continue;
    }

    // example / formula blocks
    if (block.some(l => l.kind === "example")) {
      elements.push(
        <div key={bi} className="my-3 rounded-md bg-muted/50 border border-border px-3.5 py-2.5 space-y-1">
          {block.map((l, li) => (
            <p key={li} className="text-sm font-mono text-foreground leading-relaxed">{(l as any).text}</p>
          ))}
        </div>
      );
      bi++; continue;
    }

    // step items
    if (block.some(l => l.kind === "step")) {
      elements.push(
        <div key={bi} className="space-y-1.5 my-2">
          {block.map((l, li) => {
            if (l.kind === "step" || l.kind === "paragraph") {
              return (
                <p key={li} className="text-sm text-foreground leading-relaxed">{(l as any).text}</p>
              );
            }
            return null;
          })}
        </div>
      );
      bi++; continue;
    }

    // Default: paragraph block
    elements.push(
      <div key={bi} className="space-y-1 my-2">
        {block.map((l, li) => (
          <p key={li} className="text-sm text-foreground leading-relaxed">
            {(l as any).text || ""}
          </p>
        ))}
      </div>
    );
    bi++;
  }

  return <div className="space-y-0.5">{elements}</div>;
}

// ── In-app training doc viewer ────────────────────────────────────────────────

function TrainingDocViewer() {
  const [activeKey, setActiveKey] = useState(TRAINING_MODULES[0].key);
  const [readModules, setReadModules] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("training_read_modules");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  const contentRef = useRef<HTMLDivElement>(null);

  const activeModule = TRAINING_MODULES.find(m => m.key === activeKey) || TRAINING_MODULES[0];

  const markRead = (key: string) => {
    setReadModules(prev => {
      const next = new Set(prev);
      next.add(key);
      try { localStorage.setItem("training_read_modules", JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  // Mark as read when scrolled to bottom
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
        markRead(activeKey);
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeKey]);

  // Scroll to top when module changes
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeKey]);

  const completedCount = TRAINING_MODULES.filter(m => readModules.has(m.key)).length;

  return (
    <div className="flex gap-0 rounded-xl border border-border overflow-hidden" style={{ minHeight: "640px" }}>
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-border bg-muted/30 flex flex-col">
        {/* Progress header */}
        <div className="px-4 py-3.5 border-b border-border">
          <p className="text-xs font-semibold text-foreground">Training Progress</p>
          <div className="mt-2 h-1.5 rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${(completedCount / TRAINING_MODULES.length) * 100}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">{completedCount} of {TRAINING_MODULES.length} completed</p>
        </div>

        {/* Module list */}
        <nav className="flex-1 overflow-y-auto py-2">
          {TRAINING_MODULES.map((mod) => {
            const isActive = mod.key === activeKey;
            const isRead = readModules.has(mod.key);
            const Icon = mod.icon;
            return (
              <button
                key={mod.key}
                onClick={() => setActiveKey(mod.key)}
                className={`w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors hover:bg-background/60 ${
                  isActive ? "bg-background shadow-sm border-r-2 border-primary" : ""
                }`}
                data-testid={`nav-module-${mod.key}`}
              >
                <div className={`mt-0.5 p-1.5 rounded-md ${mod.accentBg} shrink-0`}>
                  <Icon className={`w-3.5 h-3.5 ${mod.colorClass}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium leading-snug ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                    {mod.name}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{mod.readMins} min read</p>
                </div>
                {isRead && (
                  <Check className="w-3.5 h-3.5 text-green-600 shrink-0 mt-1" />
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Module header */}
        <div className={`px-6 py-4 border-b border-border ${activeModule.accentBg} bg-opacity-30`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${activeModule.accentBg}`}>
                <activeModule.icon className={`w-5 h-5 ${activeModule.colorClass}`} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">{activeModule.name}</h2>
                <p className="text-xs text-foreground/80 mt-0.5">{activeModule.description}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {readModules.has(activeModule.key) ? (
                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">
                  <Check className="w-3 h-3 mr-1" />
                  Completed
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => markRead(activeModule.key)}
                >
                  <BookMarked className="w-3 h-3 mr-1" />
                  Mark complete
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto px-6 py-5">
          <ContentRenderer content={activeModule.content} />

          {/* Next module prompt */}
          {(() => {
            const idx = TRAINING_MODULES.findIndex(m => m.key === activeKey);
            const next = TRAINING_MODULES[idx + 1];
            if (!next) return null;
            return (
              <div className="mt-10 pt-5 border-t border-border">
                <p className="text-xs text-muted-foreground mb-2">Next module</p>
                <button
                  onClick={() => setActiveKey(next.key)}
                  className="flex items-center gap-3 w-full text-left p-3 rounded-lg border border-border hover:border-primary hover:bg-muted/30 transition-colors"
                >
                  <div className={`p-1.5 rounded-md ${next.accentBg}`}>
                    <next.icon className={`w-4 h-4 ${next.colorClass}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{next.name}</p>
                    <p className="text-xs text-muted-foreground">{next.readMins} min read</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ── ScoreBar ──────────────────────────────────────────────────────────────────

function ScoreBar({ label, score, max = 10 }: { label: string; score: number; max?: number }) {
  const pct = Math.round((score / max) * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{score}/{max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct >= 80 ? "bg-green-600" : pct >= 60 ? "bg-amber-500" : "bg-destructive"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── RoleplayPractice ──────────────────────────────────────────────────────────

interface RoleplaySession {
  id: number;
  scenario: string;
  persona: string;
  difficulty: string | null;
  status: string;
  totalExchanges: number;
  overallScore: number | null;
  coachingSummary: string | null;
  strengths: string[] | null;
  gaps: string[] | null;
  suggestedPhrasing: string[] | null;
  createdAt: string;
  completedAt: string | null;
}

interface Exchange {
  id: number;
  repMessage: string;
  merchantReply: string;
  toneScore: number | null;
  clarityScore: number | null;
  objectionAddressed: boolean | null;
  feedback: string | null;
}

interface ScoreData {
  toneScore: number;
  clarityScore: number;
  objectionAddressed: boolean;
  feedback: string;
}

interface CoachingSummary {
  summary: string;
  strengths: string[];
  gaps: string[];
  suggestedPhrasing: string[];
  overallScore: number;
  avgTone: number;
  avgClarity: number;
  objectionRate: number;
}

const SCENARIOS = [
  "Cold Call",
  "Objection Handling",
  "Statement Review Close",
  "Competitor Switch",
  "0% Program Pitch",
];

type Difficulty = "standard" | "hard" | "expert";

const DIFFICULTIES: { value: Difficulty; label: string; description: string }[] = [
  { value: "standard", label: "Standard", description: "Realistic merchant — typical resistance" },
  { value: "hard", label: "Hard", description: "More skeptical, demands specifics" },
  { value: "expert", label: "Expert", description: "Sophisticated, near-impossible to convert" },
];

const PERSONAS = [
  "Auto Shop Owner",
  "Dentist",
  "Restaurant Owner",
  "Retail Store Owner",
  "Home Services Contractor",
  "Medspa Owner",
];

const normalizeDifficulty = (d: string | null | undefined): Difficulty =>
  d === "hard" || d === "expert" ? d : "standard";

const difficultyLabel = (d: string | null | undefined) =>
  DIFFICULTIES.find(x => x.value === normalizeDifficulty(d))?.label || "Standard";

const difficultyBadgeClass = (d: string | null | undefined) => {
  switch (normalizeDifficulty(d)) {
    case "hard": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
    case "expert": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
    default: return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
  }
};

function RoleplayPractice() {
  const { toast } = useToast();
  const [selectedScenario, setSelectedScenario] = useState("");
  const [selectedPersona, setSelectedPersona] = useState("");
  const [selectedDifficulty, setSelectedDifficulty] = useState<Difficulty>("standard");
  const [currentSession, setCurrentSession] = useState<RoleplaySession | null>(null);
  const [repMessage, setRepMessage] = useState("");
  const [exchanges, setExchanges] = useState<(Exchange & { score?: ScoreData })[]>([]);
  const [conversationHistory, setConversationHistory] = useState<{ role: string; content: string }[]>([]);
  const [coachingSummary, setCoachingSummary] = useState<CoachingSummary | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedHistorySession, setSelectedHistorySession] = useState<RoleplaySession | null>(null);
  const [historyExchanges, setHistoryExchanges] = useState<Exchange[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: sessions, refetch: refetchSessions } = useQuery<RoleplaySession[]>({
    queryKey: ["/api/training/roleplay/sessions"],
  });

  const startMutation = useMutation({
    mutationFn: async (overrides?: { scenario?: string; persona?: string; difficulty?: Difficulty }) => {
      const payload = {
        scenario: overrides?.scenario ?? selectedScenario,
        persona: overrides?.persona ?? selectedPersona,
        difficulty: overrides?.difficulty ?? selectedDifficulty,
      };
      const res = await apiRequest("POST", "/api/training/roleplay/start", payload);
      const session = await res.json();
      return { session, payload };
    },
    onSuccess: ({ session, payload }) => {
      setSelectedScenario(payload.scenario);
      setSelectedPersona(payload.persona);
      setSelectedDifficulty(payload.difficulty);
      setCurrentSession(session);
      setExchanges([]);
      setConversationHistory([]);
      setCoachingSummary(null);
      setRepMessage("");
    },
    onError: (err: any) => toast({ title: "Failed to start session", description: err.message, variant: "destructive" }),
  });

  const nextDifficulty = (d: string | null | undefined): Difficulty =>
    normalizeDifficulty(d) === "standard" ? "hard" : "expert";

  const retrySameScenario = () => {
    if (!currentSession) return;
    startMutation.mutate({
      scenario: currentSession.scenario,
      persona: currentSession.persona,
      difficulty: normalizeDifficulty(currentSession.difficulty),
    });
  };

  const tryHarderVersion = () => {
    if (!currentSession) return;
    startMutation.mutate({
      scenario: currentSession.scenario,
      persona: currentSession.persona,
      difficulty: nextDifficulty(currentSession.difficulty),
    });
  };

  const exchangeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/training/roleplay/exchange", {
        sessionId: currentSession!.id,
        repMessage,
        conversationHistory,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const newExchange = { ...data.exchange, score: data.score };
      setExchanges(prev => [...prev, newExchange]);
      setConversationHistory(prev => [
        ...prev,
        { role: "user", content: repMessage },
        { role: "assistant", content: data.merchantReply },
      ]);
      setRepMessage("");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    },
    onError: (err: any) => toast({ title: "Failed to send message", description: err.message, variant: "destructive" }),
  });

  const endMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/training/roleplay/end", { sessionId: currentSession!.id });
      return res.json();
    },
    onSuccess: (data) => {
      setCoachingSummary(data);
      setCurrentSession(prev => prev ? { ...prev, status: "completed" } : null);
      refetchSessions();
    },
    onError: (err: any) => toast({ title: "Failed to end session", description: err.message, variant: "destructive" }),
  });

  const loadHistorySession = async (session: RoleplaySession) => {
    setSelectedHistorySession(session);
    try {
      const res = await fetch(`/api/training/roleplay/sessions/${session.id}/exchanges`, { credentials: "include" });
      const data = await res.json();
      setHistoryExchanges(data);
    } catch {
      setHistoryExchanges([]);
    }
  };

  const resetSession = () => {
    setCurrentSession(null);
    setExchanges([]);
    setConversationHistory([]);
    setCoachingSummary(null);
    setRepMessage("");
    setSelectedScenario("");
    setSelectedPersona("");
    setSelectedDifficulty("standard");
  };

  const canStart = selectedScenario && selectedPersona;
  const isActive = currentSession && currentSession.status === "active";
  const isCompleted = currentSession && currentSession.status === "completed";

  if (showHistory) {
    return (
      <div className="space-y-4" data-testid="roleplay-history">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setShowHistory(false); setSelectedHistorySession(null); }} data-testid="button-back-to-practice">
            ← Back to Practice
          </Button>
          <h2 className="font-semibold">Session History</h2>
        </div>
        {!sessions || sessions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No practice sessions yet. Start your first roleplay above.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              {sessions.map(session => (
                <Card
                  key={session.id}
                  className={`cursor-pointer hover:shadow-sm transition-shadow ${selectedHistorySession?.id === session.id ? "border-primary" : ""}`}
                  onClick={() => loadHistorySession(session)}
                  data-testid={`card-history-session-${session.id}`}
                >
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{session.scenario}</p>
                        <p className="text-xs text-muted-foreground">{session.persona} · {new Date(session.createdAt).toLocaleDateString()}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={`text-xs ${difficultyBadgeClass(session.difficulty)}`} data-testid={`badge-difficulty-${session.id}`}>
                          {difficultyLabel(session.difficulty)}
                        </Badge>
                        {session.overallScore !== null && (
                          <Badge variant="secondary" className="text-xs" data-testid={`badge-session-score-${session.id}`}>
                            <Star className="w-3 h-3 mr-1 text-yellow-500" />
                            {session.overallScore}/10
                          </Badge>
                        )}
                        <Badge variant={session.status === "completed" ? "secondary" : "outline"} className="text-xs">
                          {session.status === "completed" ? "Done" : "Active"}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            {selectedHistorySession && (
              <div className="space-y-3">
                {selectedHistorySession.coachingSummary && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Coaching Summary</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <p className="text-muted-foreground">{selectedHistorySession.coachingSummary}</p>
                      {selectedHistorySession.overallScore !== null && (
                        <ScoreBar label="Overall Score" score={selectedHistorySession.overallScore} />
                      )}
                      {selectedHistorySession.strengths && selectedHistorySession.strengths.length > 0 && (
                        <div>
                          <p className="font-medium text-green-600 mb-1">Strengths</p>
                          <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                            {selectedHistorySession.strengths.map((s, i) => <li key={i}>{s}</li>)}
                          </ul>
                        </div>
                      )}
                      {selectedHistorySession.gaps && selectedHistorySession.gaps.length > 0 && (
                        <div>
                          <p className="font-medium text-amber-600 mb-1">Areas to Improve</p>
                          <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                            {selectedHistorySession.gaps.map((g, i) => <li key={i}>{g}</li>)}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">{historyExchanges.length} Exchanges</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {historyExchanges.map((ex) => (
                      <div key={ex.id} className="border rounded-md p-3 space-y-2 text-sm">
                        <div className="flex items-start gap-2">
                          <User className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                          <span>{ex.repMessage}</span>
                        </div>
                        <div className="flex items-start gap-2 text-muted-foreground">
                          <Bot className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          <span>{ex.merchantReply}</span>
                        </div>
                        {ex.toneScore !== null && (
                          <div className="flex gap-3 pt-1">
                            <Badge variant="outline" className="text-xs">Tone {ex.toneScore}/10</Badge>
                            <Badge variant="outline" className="text-xs">Clarity {ex.clarityScore}/10</Badge>
                            {ex.objectionAddressed && <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">Objection ✓</Badge>}
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="roleplay-practice">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Brain className="w-5 h-5 text-primary" />
            AI Roleplay Coach
          </h2>
          <p className="text-sm text-muted-foreground">Practice sales scenarios with an AI merchant persona — get scored and coached in real time.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowHistory(true)} data-testid="button-view-history">
          <History className="w-4 h-4 mr-2" />
          History {sessions && sessions.length > 0 ? `(${sessions.length})` : ""}
        </Button>
      </div>

      {!currentSession ? (
        <Card data-testid="card-start-session">
          <CardHeader>
            <CardTitle className="text-base">Start a Practice Session</CardTitle>
            <CardDescription>Choose a scenario and merchant persona to practice with</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Scenario</label>
                <Select value={selectedScenario} onValueChange={setSelectedScenario}>
                  <SelectTrigger data-testid="select-scenario">
                    <SelectValue placeholder="Choose a scenario..." />
                  </SelectTrigger>
                  <SelectContent>
                    {SCENARIOS.map(s => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Merchant Persona</label>
                <Select value={selectedPersona} onValueChange={setSelectedPersona}>
                  <SelectTrigger data-testid="select-persona">
                    <SelectValue placeholder="Choose a merchant..." />
                  </SelectTrigger>
                  <SelectContent>
                    {PERSONAS.map(p => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {SCENARIOS.map(s => (
                <button
                  key={s}
                  onClick={() => setSelectedScenario(s)}
                  className={`p-3 rounded-lg border text-left text-sm transition-colors hover:border-primary ${selectedScenario === s ? "border-primary bg-primary/5 font-medium" : "border-border"}`}
                  data-testid={`button-scenario-${s.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Difficulty</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {DIFFICULTIES.map(d => (
                  <button
                    key={d.value}
                    onClick={() => setSelectedDifficulty(d.value)}
                    className={`p-3 rounded-lg border text-left text-sm transition-colors hover:border-primary ${selectedDifficulty === d.value ? "border-primary bg-primary/5 font-medium" : "border-border"}`}
                    data-testid={`button-difficulty-${d.value}`}
                  >
                    <div className="font-medium">{d.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{d.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <Button
              className="w-full"
              disabled={!canStart || startMutation.isPending}
              onClick={() => startMutation.mutate(undefined)}
              data-testid="button-start-session"
            >
              {startMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              {startMutation.isPending ? "Starting..." : "Start Practice Session"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary">{currentSession.scenario}</Badge>
              <Badge variant="outline">{currentSession.persona}</Badge>
              <Badge className={difficultyBadgeClass(currentSession.difficulty)} data-testid="badge-current-difficulty">
                {difficultyLabel(currentSession.difficulty)}
              </Badge>
              {isCompleted && <Badge className="bg-green-600 text-white">Session Complete</Badge>}
            </div>
            <div className="flex gap-2">
              {isActive && exchanges.length >= 1 && (
                <Button variant="outline" size="sm" onClick={() => endMutation.mutate()} disabled={endMutation.isPending} data-testid="button-end-session">
                  {endMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-1" />}
                  End & Get Feedback
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={resetSession} data-testid="button-reset-session">
                <RotateCcw className="w-4 h-4 mr-1" />
                New Session
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
              <Card data-testid="card-conversation">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    Conversation
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-64 pr-2">
                    {exchanges.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-sm text-muted-foreground py-8">
                        Start the conversation — type what you'd say to this merchant.
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {exchanges.map((ex, i) => (
                          <div key={ex.id} className="space-y-3" data-testid={`exchange-${i}`}>
                            <div className="flex items-start gap-2">
                              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                                <User className="w-3 h-3 text-primary" />
                              </div>
                              <div className="flex-1">
                                <p className="text-sm font-medium mb-0.5">You</p>
                                <p className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-2.5">{ex.repMessage}</p>
                              </div>
                            </div>
                            <div className="flex items-start gap-2">
                              <div className="w-6 h-6 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                                <Bot className="w-3 h-3 text-amber-600" />
                              </div>
                              <div className="flex-1">
                                <p className="text-sm font-medium mb-0.5">{currentSession.persona}</p>
                                <p className="text-sm text-muted-foreground rounded-lg p-2.5 border">{ex.merchantReply}</p>
                                {ex.toneScore !== null && (
                                  <div className="flex gap-2 mt-1.5 flex-wrap">
                                    <Badge variant="outline" className="text-xs" data-testid={`badge-tone-${i}`}>Tone {ex.toneScore}/10</Badge>
                                    <Badge variant="outline" className="text-xs" data-testid={`badge-clarity-${i}`}>Clarity {ex.clarityScore}/10</Badge>
                                    {ex.objectionAddressed ? (
                                      <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" data-testid={`badge-objection-${i}`}>
                                        Objection ✓
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-xs text-amber-600" data-testid={`badge-objection-missed-${i}`}>
                                        Objection not addressed
                                      </Badge>
                                    )}
                                    {ex.feedback && (
                                      <span className="text-xs text-muted-foreground italic w-full mt-0.5" data-testid={`text-feedback-${i}`}>💡 {ex.feedback}</span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                        <div ref={bottomRef} />
                      </div>
                    )}
                  </ScrollArea>

                  {isActive && (
                    <div className="mt-4 flex gap-2">
                      <Textarea
                        placeholder={`What would you say to this ${currentSession.persona.toLowerCase()}?`}
                        value={repMessage}
                        onChange={(e) => setRepMessage(e.target.value)}
                        className="resize-none text-sm"
                        rows={3}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && repMessage.trim()) {
                            e.preventDefault();
                            exchangeMutation.mutate();
                          }
                        }}
                        data-testid="textarea-rep-message"
                      />
                      <Button
                        className="self-end"
                        disabled={!repMessage.trim() || exchangeMutation.isPending}
                        onClick={() => exchangeMutation.mutate()}
                        data-testid="button-send-message"
                      >
                        {exchangeMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      </Button>
                    </div>
                  )}
                  {isActive && (
                    <p className="text-xs text-muted-foreground mt-1.5">Tip: Press Cmd+Enter to send</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              {exchanges.length > 0 && (
                <Card data-testid="card-running-scores">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Turn Scores</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {exchanges.map((ex, i) => (
                      <div key={ex.id} className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">Turn {i + 1}</p>
                        {ex.toneScore !== null && (
                          <>
                            <ScoreBar label="Tone" score={ex.toneScore} />
                            <ScoreBar label="Clarity" score={ex.clarityScore ?? 0} />
                          </>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {coachingSummary && (
                <Card className="border-green-200 dark:border-green-800" data-testid="card-coaching-summary">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Trophy className="w-4 h-4 text-yellow-500" />
                      Session Complete
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="space-y-1.5">
                      <ScoreBar label="Overall Score" score={coachingSummary.overallScore} />
                      <ScoreBar label="Avg Tone" score={coachingSummary.avgTone} />
                      <ScoreBar label="Avg Clarity" score={coachingSummary.avgClarity} />
                    </div>
                    <p className="text-muted-foreground text-xs leading-relaxed">{coachingSummary.summary}</p>
                    {coachingSummary.strengths.length > 0 && (
                      <div>
                        <p className="font-medium text-green-600 text-xs mb-1">Strengths</p>
                        <ul className="space-y-0.5">
                          {coachingSummary.strengths.map((s, i) => (
                            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1">
                              <CheckCircle className="w-3 h-3 text-green-600 mt-0.5 shrink-0" /> {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {coachingSummary.gaps.length > 0 && (
                      <div>
                        <p className="font-medium text-amber-600 text-xs mb-1">Improve</p>
                        <ul className="space-y-0.5">
                          {coachingSummary.gaps.map((g, i) => (
                            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1">
                              <ChevronRight className="w-3 h-3 text-amber-600 mt-0.5 shrink-0" /> {g}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {coachingSummary.suggestedPhrasing.length > 0 && (
                      <div>
                        <p className="font-medium text-primary text-xs mb-1">Try saying:</p>
                        <ul className="space-y-1">
                          {coachingSummary.suggestedPhrasing.map((p, i) => (
                            <li key={i} className="text-xs text-muted-foreground italic border-l-2 border-primary pl-2">{p}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="pt-2 border-t space-y-2">
                      <p className="text-xs font-medium">Practice again</p>
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={retrySameScenario}
                          disabled={startMutation.isPending}
                          data-testid="button-retry-same"
                        >
                          <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                          Retry Same Scenario
                        </Button>
                        {normalizeDifficulty(currentSession?.difficulty) !== "expert" && (
                          <Button
                            size="sm"
                            onClick={tryHarderVersion}
                            disabled={startMutation.isPending}
                            data-testid="button-try-harder"
                          >
                            <TrendingUp className="w-3.5 h-3.5 mr-1.5" />
                            Try a Harder Version ({difficultyLabel(nextDifficulty(currentSession?.difficulty))})
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CoachingDashboard ─────────────────────────────────────────────────────────

interface AdminSession extends RoleplaySession {
  userId: string | null;
  userEmail: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userRole: string | null;
  avgTone: number | null;
  avgClarity: number | null;
}

interface RepSummary {
  userId: string;
  name: string;
  email: string;
  role: string;
  sessionsCompleted: number;
  totalSessions: number;
  avgTone: number | null;
  avgClarity: number | null;
  avgOverall: number | null;
  lastSessionAt: string | null;
  sessions: AdminSession[];
}

function CoachingDashboard() {
  const [selectedRep, setSelectedRep] = useState<RepSummary | null>(null);
  const [selectedSession, setSelectedSession] = useState<AdminSession | null>(null);
  const [drillExchanges, setDrillExchanges] = useState<Exchange[]>([]);
  const [loadingExchanges, setLoadingExchanges] = useState(false);

  const { data: sessions, isLoading } = useQuery<AdminSession[]>({
    queryKey: ["/api/training/roleplay/admin/sessions"],
  });

  const reps: RepSummary[] = (() => {
    if (!sessions) return [];
    const map = new Map<string, RepSummary>();
    for (const s of sessions) {
      if (!s.userId) continue;
      const name = [s.userFirstName, s.userLastName].filter(Boolean).join(" ") || s.userEmail || "Unknown";
      const existing = map.get(s.userId) || {
        userId: s.userId,
        name,
        email: s.userEmail || "",
        role: s.userRole || "agent",
        sessionsCompleted: 0,
        totalSessions: 0,
        avgTone: null,
        avgClarity: null,
        avgOverall: null,
        lastSessionAt: null,
        sessions: [],
      };
      existing.totalSessions += 1;
      if (s.status === "completed") existing.sessionsCompleted += 1;
      existing.sessions.push(s);
      if (!existing.lastSessionAt || (s.createdAt && s.createdAt > existing.lastSessionAt)) {
        existing.lastSessionAt = s.createdAt;
      }
      map.set(s.userId, existing);
    }
    for (const rep of Array.from(map.values())) {
      const tones = rep.sessions.map(s => s.avgTone).filter((v): v is number => v !== null);
      const clarities = rep.sessions.map(s => s.avgClarity).filter((v): v is number => v !== null);
      const overalls = rep.sessions.map(s => s.overallScore).filter((v): v is number => v !== null);
      const avg = (a: number[]) => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null;
      rep.avgTone = avg(tones);
      rep.avgClarity = avg(clarities);
      rep.avgOverall = avg(overalls);
    }
    return Array.from(map.values()).sort((a, b) => (b.lastSessionAt || "").localeCompare(a.lastSessionAt || ""));
  })();

  const loadSession = async (s: AdminSession) => {
    setSelectedSession(s);
    setDrillExchanges([]);
    setLoadingExchanges(true);
    try {
      const res = await fetch(`/api/training/roleplay/admin/sessions/${s.id}/exchanges`, { credentials: "include" });
      const data = await res.json();
      setDrillExchanges(data);
    } catch {
      setDrillExchanges([]);
    } finally {
      setLoadingExchanges(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="coaching-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!reps.length) {
    return (
      <Card data-testid="coaching-empty">
        <CardContent className="py-12 text-center text-muted-foreground">
          <Users className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No roleplay activity yet</p>
          <p className="text-sm mt-1">Once reps start practicing, their scores and trends will show up here.</p>
        </CardContent>
      </Card>
    );
  }

  if (selectedRep && selectedSession) {
    return (
      <div className="space-y-4" data-testid="coaching-session-detail">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setSelectedSession(null); setDrillExchanges([]); }} data-testid="button-back-to-rep">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to {selectedRep.name}
          </Button>
        </div>
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-base">{selectedSession.scenario}</CardTitle>
                <CardDescription>
                  {selectedSession.persona} · {selectedSession.createdAt ? new Date(selectedSession.createdAt).toLocaleString() : ""}
                </CardDescription>
              </div>
              {selectedSession.overallScore !== null && (
                <Badge variant="secondary" data-testid="badge-detail-overall">
                  <Star className="w-3 h-3 mr-1 text-yellow-500" />
                  Overall {selectedSession.overallScore}/10
                </Badge>
              )}
            </div>
          </CardHeader>
          {selectedSession.coachingSummary && (
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">{selectedSession.coachingSummary}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {selectedSession.overallScore !== null && <ScoreBar label="Overall" score={selectedSession.overallScore} />}
                {selectedSession.avgTone !== null && <ScoreBar label="Avg Tone" score={Math.round(selectedSession.avgTone)} />}
                {selectedSession.avgClarity !== null && <ScoreBar label="Avg Clarity" score={Math.round(selectedSession.avgClarity)} />}
              </div>
              {selectedSession.strengths && selectedSession.strengths.length > 0 && (
                <div>
                  <p className="font-medium text-green-600 mb-1">Strengths</p>
                  <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                    {selectedSession.strengths.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
              {selectedSession.gaps && selectedSession.gaps.length > 0 && (
                <div>
                  <p className="font-medium text-amber-600 mb-1">Areas to Improve</p>
                  <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                    {selectedSession.gaps.map((g, i) => <li key={i}>{g}</li>)}
                  </ul>
                </div>
              )}
              {selectedSession.suggestedPhrasing && selectedSession.suggestedPhrasing.length > 0 && (
                <div>
                  <p className="font-medium text-primary mb-1">Suggested phrasing</p>
                  <ul className="space-y-1">
                    {selectedSession.suggestedPhrasing.map((p, i) => (
                      <li key={i} className="text-xs text-muted-foreground italic border-l-2 border-primary pl-2">{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          )}
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{drillExchanges.length} Exchanges</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingExchanges ? (
              <Skeleton className="h-24 w-full" />
            ) : drillExchanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">No exchanges recorded.</p>
            ) : drillExchanges.map((ex) => (
              <div key={ex.id} className="border rounded-md p-3 space-y-2 text-sm" data-testid={`exchange-detail-${ex.id}`}>
                <div className="flex items-start gap-2">
                  <User className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                  <span>{ex.repMessage}</span>
                </div>
                <div className="flex items-start gap-2 text-muted-foreground">
                  <Bot className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{ex.merchantReply}</span>
                </div>
                {ex.toneScore !== null && (
                  <div className="flex gap-3 pt-1 flex-wrap">
                    <Badge variant="outline" className="text-xs">Tone {ex.toneScore}/10</Badge>
                    <Badge variant="outline" className="text-xs">Clarity {ex.clarityScore}/10</Badge>
                    {ex.objectionAddressed && <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">Objection ✓</Badge>}
                  </div>
                )}
                {ex.feedback && <p className="text-xs italic text-muted-foreground">💡 {ex.feedback}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (selectedRep) {
    return (
      <div className="space-y-4" data-testid="coaching-rep-detail">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setSelectedRep(null)} data-testid="button-back-to-reps">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to all reps
          </Button>
        </div>
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between flex-wrap gap-2">
              <div>
                <CardTitle data-testid="text-rep-name">{selectedRep.name}</CardTitle>
                <CardDescription>{selectedRep.email} · {selectedRep.role}</CardDescription>
              </div>
              <div className="flex gap-2 flex-wrap">
                <Badge variant="outline" data-testid="badge-rep-completed">{selectedRep.sessionsCompleted} completed</Badge>
                {selectedRep.avgOverall !== null && (
                  <Badge variant="secondary" data-testid="badge-rep-avg-overall">
                    <Star className="w-3 h-3 mr-1 text-yellow-500" />
                    Avg {selectedRep.avgOverall}/10
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {selectedRep.avgOverall !== null && <ScoreBar label="Avg Overall" score={Math.round(selectedRep.avgOverall)} />}
            {selectedRep.avgTone !== null && <ScoreBar label="Avg Tone" score={Math.round(selectedRep.avgTone)} />}
            {selectedRep.avgClarity !== null && <ScoreBar label="Avg Clarity" score={Math.round(selectedRep.avgClarity)} />}
          </CardContent>
        </Card>
        <div className="space-y-2">
          <h3 className="font-medium text-sm">Session History ({selectedRep.sessions.length})</h3>
          {selectedRep.sessions.map(s => (
            <Card
              key={s.id}
              className="cursor-pointer hover:shadow-sm transition-shadow"
              onClick={() => loadSession(s)}
              data-testid={`card-rep-session-${s.id}`}
            >
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{s.scenario}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.persona} · {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ""} · {s.totalExchanges} turns
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {s.avgTone !== null && <Badge variant="outline" className="text-xs">Tone {s.avgTone}</Badge>}
                    {s.avgClarity !== null && <Badge variant="outline" className="text-xs">Clarity {s.avgClarity}</Badge>}
                    {s.overallScore !== null && (
                      <Badge variant="secondary" className="text-xs">
                        <Star className="w-3 h-3 mr-1 text-yellow-500" />
                        {s.overallScore}/10
                      </Badge>
                    )}
                    <Badge variant={s.status === "completed" ? "secondary" : "outline"} className="text-xs">
                      {s.status === "completed" ? "Done" : "Active"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="coaching-rep-list">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" />
            Team Coaching
          </h2>
          <p className="text-sm text-muted-foreground">Review your team's roleplay activity, scores, and trends. Click a rep to drill into their sessions.</p>
        </div>
        <Badge variant="outline" data-testid="badge-rep-count">{reps.length} {reps.length === 1 ? "rep" : "reps"}</Badge>
      </div>
      <div className="space-y-2">
        {reps.map(rep => (
          <Card
            key={rep.userId}
            className="cursor-pointer hover:shadow-sm transition-shadow"
            onClick={() => setSelectedRep(rep)}
            data-testid={`card-rep-${rep.userId}`}
          >
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm" data-testid={`text-rep-name-${rep.userId}`}>{rep.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {rep.email} · last session {rep.lastSessionAt ? new Date(rep.lastSessionAt).toLocaleDateString() : "—"}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs" data-testid={`badge-rep-sessions-${rep.userId}`}>
                    {rep.sessionsCompleted}/{rep.totalSessions} sessions
                  </Badge>
                  {rep.avgTone !== null && (
                    <Badge variant="outline" className="text-xs" data-testid={`badge-rep-tone-${rep.userId}`}>Tone {rep.avgTone}</Badge>
                  )}
                  {rep.avgClarity !== null && (
                    <Badge variant="outline" className="text-xs" data-testid={`badge-rep-clarity-${rep.userId}`}>Clarity {rep.avgClarity}</Badge>
                  )}
                  {rep.avgOverall !== null && (
                    <Badge variant="secondary" className="text-xs" data-testid={`badge-rep-overall-${rep.userId}`}>
                      <Star className="w-3 h-3 mr-1 text-yellow-500" />
                      {rep.avgOverall}/10
                    </Badge>
                  )}
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Main Training page ────────────────────────────────────────────────────────

export default function Training() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  const role = (user?.role as string) || "merchant";
  const isInternalUser = role === "admin" || role === "manager" || role === "agent";
  const canManageHub = role === "admin" || role === "manager";

  // The URL owns the selected tab (?tab=docs|practice|coaching). Coaching is manager/admin only.
  const trainingSelection = useC4RetainedSelection("/dashboard/training", "tab", trainingViews, "docs");
  const trainingTab = trainingSelection.value === "coaching" && !canManageHub ? "docs" : trainingSelection.value;

  useEffect(() => {
    if (user && !isInternalUser) {
      setLocation("/dashboard");
    }
  }, [user, isInternalUser, setLocation]);

  if (!isInternalUser) return null;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <ResourcesNav current="/dashboard/training" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-training-title">
          <BookOpen className="w-7 h-7 text-primary" />
          Sales Training Hub
        </h1>
        <p className="text-muted-foreground mt-1">
          Structured training guides and AI-powered roleplay practice for every stage of the sales process.
        </p>
      </div>

      {(trainingSelection.issues.length > 0 || trainingSelection.value !== trainingTab) && (
        <p role="status" className="mb-4 text-sm text-muted-foreground" data-testid="text-training-selection-issue">
          {trainingSelection.issues[0]?.reason ?? "Team Coaching requires a manager or administrator. Showing Training Guides."}
        </p>
      )}
      <Tabs value={trainingTab} onValueChange={(v) => trainingSelection.setValue(v as typeof trainingViews[number])} className="w-full">
        <TabsList className="mb-6 flex-wrap h-auto gap-1" data-testid="tabs-training">
          <TabsTrigger value="docs" data-testid="tab-docs">
            <BookOpen className="w-4 h-4 mr-2" />
            Training Guides
          </TabsTrigger>
          <TabsTrigger value="practice" data-testid="tab-practice">
            <Brain className="w-4 h-4 mr-2" />
            AI Practice
          </TabsTrigger>
          {canManageHub && (
            <TabsTrigger value="coaching" data-testid="tab-coaching">
              <ClipboardList className="w-4 h-4 mr-2" />
              Team Coaching
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="docs">
          <TrainingDocViewer />
        </TabsContent>

        <TabsContent value="practice">
          <RoleplayPractice />
        </TabsContent>

        {canManageHub && (
          <TabsContent value="coaching">
            <CoachingDashboard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
