import { GhlOwnershipNotice } from "@/components/dashboard/GhlOwnershipNotice";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Megaphone, Copy, CheckCircle2, Mail, MessageSquare, Phone, Linkedin,
  Facebook, Instagram, ChevronDown, ChevronUp, Printer, Workflow,
  AlertTriangle, Clock, Upload, Eye, CheckSquare,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface EmailSequence {
  label: string;
  subject: string;
  body: string;
}

interface SocialAdSet {
  facebook: { headline: string; primaryText: string; description: string };
  instagram: { hook: string; caption: string };
  linkedin: string;
}

// ─── GHL Workflows ─────────────────────────────────────────────────────────────

interface GhlWorkflow {
  num: number;
  name: string;
  trigger: string;
  steps: number;
  timing: string;
  repRole: string;
}

const GHL_WORKFLOWS: GhlWorkflow[] = [
  {
    num: 1,
    name: "Speed-to-Lead",
    trigger: "Form submit / chat",
    steps: 9,
    timing: "Mins 1–72h",
    repRole: "Review AI reply, confirm booking",
  },
  {
    num: 2,
    name: "Cold Outbound",
    trigger: "SDR enrichment",
    steps: 9,
    timing: "Day 1–12",
    repRole: "Monitor intent flags, call on day 3",
  },
  {
    num: 3,
    name: "Reply Engaged",
    trigger: "Any reply",
    steps: 6,
    timing: "Hours",
    repRole: "Assign to rep within 30 min",
  },
  {
    num: 4,
    name: "Statement Chase",
    trigger: "Verbal agreement",
    steps: 6,
    timing: "Days 1–7",
    repRole: "Call on day 2 if no upload",
  },
  {
    num: 5,
    name: "Proposal Follow-up",
    trigger: "Proposal sent",
    steps: 7,
    timing: "Days 1–10",
    repRole: "Personal call on day 3",
  },
  {
    num: 6,
    name: "Long-term Nurture",
    trigger: "Exhausted sequences",
    steps: 8,
    timing: "Monthly ×12",
    repRole: "Quarterly personal touch",
  },
];

const REP_DAILY_ACTIONS = [
  {
    icon: AlertTriangle,
    iconClass: "text-red-500",
    text: "Check intent flags in Lead Command Center — angry/stop = immediate action required",
  },
  {
    icon: Clock,
    iconClass: "text-amber-500",
    text: "Call any leads that replied interested or call_me within 1 hour",
  },
  {
    icon: Upload,
    iconClass: "text-blue-500",
    text: "Upload new statements received to the deal file same day",
  },
  {
    icon: Eye,
    iconClass: "text-purple-500",
    text: "Review any proposals opened in the last 24h (proposal_viewed intent auto-fires)",
  },
];

// ─── Verticals ─────────────────────────────────────────────────────────────────

const VERTICALS = ["Auto Shop", "MedSpa", "Jewelry", "Veterinary", "Dental"] as const;
type Vertical = typeof VERTICALS[number];

// ─── Email Templates ────────────────────────────────────────────────────────────

const EMAIL_SEQUENCES: Record<Vertical, EmailSequence[]> = {
  "Auto Shop": [
    {
      label: "Email 1 — Day 1",
      subject: "Auto shops on Square or Clover are overpaying — here's the math",
      body: `Hi {{firstName}},

If your auto shop is running on Square or Clover, you're likely paying 2.6–2.75% on every transaction — including your biggest repair invoices.

On a $2,500 transmission job, that's $65 in processing fees. On a $4,000 brake and suspension job, it's $110. Multiply that across your monthly volume and it's a significant line item on your P&L.

At Liberty Bancard, we've helped dozens of independent auto shops cut that cost:

✓ Interchange-plus pricing — dramatically lower on large, high-ticket invoices
✓ Cash discount / dual-pricing program — eliminate your processing fees entirely
✓ Free modern terminal or integration with your shop management software
✓ Same-day or next-day funding — critical when you're fronting parts costs
✓ No long-term contract required

For a shop doing $70K/month in card volume, switching from 2.65% flat to interchange-plus saves $400–$700/month. The cash discount option can push that to $1,500+/month.

Can I run a free comparison on your statement?

{{agentName}}
Liberty Bancard
{{agentPhone}}`,
    },
    {
      label: "Email 2 — Day 4 Follow-Up",
      subject: "Auto shop processing — the cash discount angle",
      body: `Hi {{firstName}},

One thing I didn't highlight in my first email: for auto shops, the cash discount program is often the biggest win.

Customers paying by credit card see a price that includes the processing cost built in. Customers paying cash get a discount (typically 3–4%). The net result is that your processing cost drops to near zero — legally, and with full card-brand approval.

Many shops we work with eliminate $1,000–$2,500/month in processing fees with this structure.

Forward your last processing statement to {{agentEmail}} and I'll show you exactly what both options — interchange-plus and cash discount — would look like for your volume.

{{agentName}}
Liberty Bancard`,
    },
    {
      label: "Email 3 — Day 9 Final",
      subject: "Last note for {{businessName}} — processing cost review",
      body: `Hi {{firstName}},

I'll wrap up here — I know you're busy running the shop.

Most independent auto shops are paying $500–$1,500/month more than they need to in processing fees, primarily because Square and Clover use flat-rate pricing that isn't optimized for large repair invoices.

If that number sounds meaningful to your business, I'm happy to run the comparison for free: {{agentEmail}}

No commitment, no obligation — just the numbers.

{{agentName}}
Liberty Bancard`,
    },
  ],

  MedSpa: [
    {
      label: "Email 1 — Day 1",
      subject: "Med spas on Square or Stripe are losing $700–$2,500/month — here's why",
      body: `Hi {{firstName}},

Med spas run some of the highest average ticket sizes in the service industry — Botox, filler, laser treatments, and membership packages at $300–$1,500 per visit. That makes your payment processor choice one of the highest-impact financial decisions in your business.

If you're using Square or Stripe at 2.6–2.9% flat, you're paying the same rate on a $1,200 Sculptra appointment as you would on a $10 coffee.

At Liberty Bancard, we build payment programs specifically for med spas:

✓ Interchange-plus pricing — lower effective rate on high-ticket treatments
✓ Cash discount program — shift processing cost to card-paying clients
✓ Membership and package recurring billing — tokenized, PCI-compliant
✓ Chargeback protection for prepaid treatment packages
✓ Integration with Jane, Vagaro, Mindbody, Zenoti, and Aesthetic Record
✓ Same-day funding

Med spas doing $80K–$150K/month typically save $700–$2,500/month after switching.

Can I run a free analysis on your current statement?

{{agentName}}
Liberty Bancard
{{agentPhone}}`,
    },
    {
      label: "Email 2 — Day 4 Follow-Up",
      subject: "Med spa cash discount — the $2,000/month opportunity",
      body: `Hi {{firstName}},

For med spas specifically, the cash discount program is often the highest-ROI move.

A practice doing 150 treatments at an average $700 ticket runs $105K/month through their processor. At 2.7% flat, that's $2,835/month in fees. With a properly structured cash discount program, that cost shifts to card-paying clients — your effective cost drops to near zero.

That $2,835/month could fund a new laser head, cover a part-time esthetician's salary, or simply improve your margin on every appointment.

Send your last processing statement to {{agentEmail}} and I'll put together a complete side-by-side within 24 hours.

{{agentName}}
Liberty Bancard`,
    },
    {
      label: "Email 3 — Day 9 Final",
      subject: "Last note — med spa processing cost",
      body: `Hi {{firstName}},

Wrapping up here — I know your inbox is full.

The short version: if your med spa is doing $80K+/month in card volume on Square or Stripe, there's likely $700–$2,500/month in savings available through better pricing or a cash discount program.

Whenever it makes sense: {{agentEmail}}

{{agentName}}
Liberty Bancard`,
    },
  ],

  Jewelry: [
    {
      label: "Email 1 — Day 1",
      subject: "Jewelry retailers: First Data and Fiserv are expensive — there's a better option",
      body: `Hi {{firstName}},

Jewelry stores have some of the highest average transaction values in retail — and that makes your choice of payment processor a high-stakes decision. If you're on First Data, Fiserv, or a similar legacy processor, you're likely paying bundled or tiered rates that don't reflect the true interchange cost on your high-value sales.

At Liberty Bancard, we specialize in high-ticket retail:

✓ Interchange-plus pricing — transparent, no hidden markups on premium cards
✓ Cash discount / dual-pricing program — shift processing cost to card-paying customers
✓ High-limit authorization support for large purchases ($5K–$50K)
✓ Chargeback protection — critical for high-value item disputes
✓ Same-day funding so your cash flow matches your sales pace

For a jewelry retailer doing $120K/month in card volume, the difference between 2.8% bundled and interchange-plus can be $800–$1,400/month. The cash discount option can add another $1,500–$2,500/month back to the business.

Can I run a free analysis on your current statement?

{{agentName}}
Liberty Bancard
{{agentPhone}}`,
    },
    {
      label: "Email 2 — Day 4 Follow-Up",
      subject: "Jewelry retail processing — cash discount + high-ticket auth",
      body: `Hi {{firstName}},

Two things worth highlighting specifically for jewelry retail:

1. Cash discount program: On a $3,000 diamond ring, a 3.5% processing fee is $105. A properly structured cash discount program shifts that cost to card-paying customers — entirely legally. Most jewelry stores implementing this recover $1,500–$3,000/month in what were previously processing fees.

2. High-ticket authorization support: Sales over $5K require specific authorization handling to minimize declines and downgrade risks. We configure this correctly from day one.

Send your last processing statement to {{agentEmail}} and I'll put together a full comparison within 24 hours.

{{agentName}}
Liberty Bancard`,
    },
    {
      label: "Email 3 — Day 9 Final",
      subject: "Final note — jewelry processing cost review",
      body: `Hi {{firstName}},

This is my last note — I don't want to be a nuisance.

The short version: if your jewelry store is doing $80K+/month in card volume on First Data, Fiserv, or a similar legacy processor, there is almost certainly $800–$2,000/month in savings available — either through better pricing, a cash discount program, or both.

If the timing is ever right: {{agentEmail}}

{{agentName}}
Liberty Bancard`,
    },
  ],

  Veterinary: [
    {
      label: "Email 1 — Day 1",
      subject: "Vet practices on VetPay or Square are usually overpaying — here's the math",
      body: `Hi {{firstName}},

Veterinary practices deal with a unique payment mix: emergency visits with large, unexpected invoices, routine care, and an increasing share of premium rewards credit cards — which carry some of the highest interchange rates in the industry.

If you're processing through VetPay, Square, or your practice management software's built-in payments, you're likely on a flat rate of 2.6–3.2%.

At Liberty Bancard, we work with independent vet practices and specialty animal hospitals:

✓ Interchange-plus pricing — optimized for your specific transaction mix
✓ Large emergency invoice support — high-ticket authorizations handled correctly
✓ Integration with Avimark, eVetPractice, Cornerstone, and other vet PMS platforms
✓ Same-day funding — critical when you're managing supply and medication costs
✓ No long-term contract required

For a vet practice doing $80K/month in card volume, moving from 2.9% flat to interchange-plus typically saves $500–$900/month.

Can I run a free analysis on your current processing statement?

{{agentName}}
Liberty Bancard
{{agentPhone}}`,
    },
    {
      label: "Email 2 — Day 4 Follow-Up",
      subject: "Veterinary practice processing — the premium card problem",
      body: `Hi {{firstName}},

One thing worth highlighting for vet practices specifically:

Your clients are increasingly paying with premium rewards credit cards (Chase Sapphire, Amex Platinum, etc.). These cards carry some of the highest interchange rates in the system — often 2.3–2.5% just for interchange before processor markup.

On a flat-rate processor at 2.75%, you're paying about the same whether the card is a basic debit card or an Amex Gold. With interchange-plus, your debit and standard cards come in significantly cheaper, which brings your blended effective rate down.

For a practice doing $80K/month in cards, that optimization alone is often $400–$700/month.

Forward your last processing statement to {{agentEmail}} and I'll show you exactly where the savings are for your specific card mix.

{{agentName}}
Liberty Bancard`,
    },
    {
      label: "Email 3 — Day 9 Final",
      subject: "Last note — processing cost review for your practice",
      body: `Hi {{firstName}},

Last note from me — I don't want to overstay my welcome.

If your veterinary practice ever wants an independent look at what you're paying in processing fees vs. what you should be paying, I'm here: {{agentEmail}}

Most vet practices we work with save $500–$900/month. The analysis is free, takes 24 hours, and comes with no obligation.

{{agentName}}
Liberty Bancard`,
    },
  ],

  Dental: [
    {
      label: "Email 1 — Day 1",
      subject: "On $80K/month in dental volume, 3% vs. 2% = $9,600/year — is your practice on the right side?",
      body: `Hi {{firstName}},

Dentrix and Eaglesoft are excellent practice management systems — but their built-in payment processors charge 2.5–3.5% flat rates while interchange-plus pricing delivers the same seamless integration at 1.8–2.1% for most dental card types.

On $80K/month in card transactions, the difference between 3% flat and 2% interchange-plus is $800/month — $9,600 a year back to your practice.

At Liberty Bancard, we integrate with Dentrix, Eaglesoft, and all major dental practice management platforms without changing your front-desk workflow:

✓ Interchange-plus pricing — no bundled flat rates, full transparency
✓ Drop-in integration with Dentrix, Eaglesoft, Carestream, and others
✓ Patient payment plan billing — recurring, built in, no extra cost
✓ HSA/FSA card support
✓ Same-day funding
✓ Free equipment and setup — no disruption to how you work today

I'd love to run a complimentary analysis on your current statement. Can we schedule 10 minutes this week?

{{agentName}}
Liberty Bancard
{{agentPhone}}`,
    },
    {
      label: "Email 2 — Day 4 Follow-Up",
      subject: "Dentrix/Eaglesoft processing vs. interchange-plus — the $9,600 number",
      body: `Hi {{firstName}},

Quick number: on $80K/month in card volume, the difference between 3% flat (the rate most dental software processors charge) and 2% interchange-plus is $800/month — or $9,600 a year.

Most practices we work with were paying that gap without realizing it. The switch takes about a day and doesn't change your front-desk workflow in Dentrix or Eaglesoft — we integrate directly.

Forward your last processing statement to {{agentEmail}} and I'll have a line-by-line breakdown back within 24 hours.

{{agentName}}
Liberty Bancard`,
    },
    {
      label: "Email 3 — Day 9 Final",
      subject: "Last note — your Dentrix/Eaglesoft processing cost",
      body: `Hi {{firstName}},

I'll keep this short — this is my last note on the subject.

If your practice is processing $60K–$100K/month through your dental software's built-in payment system, there's a very good chance you're paying $600–$1,000/month more than you need to.

The math is simple, the switch is painless (we integrate with your PMS directly), and the analysis is completely free.

If you ever want to know where you stand: {{agentEmail}}

{{agentName}}
Liberty Bancard`,
    },
  ],
};

// ─── Social Ad Copy ─────────────────────────────────────────────────────────────

const SOCIAL_ADS: Record<Vertical, SocialAdSet> = {
  "Auto Shop": {
    facebook: {
      headline: "$500–$1,500/month back in your auto shop — for free",
      primaryText: "If your {{city}} auto shop is running on Square or Clover, you're likely overpaying $500–$1,500/month on processing fees for {{businessName}}.\n\nWe help independent auto shops switch to interchange-plus pricing + cash discount programs that cut fees dramatically — or eliminate them entirely.\n\nFree statement analysis. No contract. No commitment. Just the numbers.\n\n→ Get your free statement analysis today.",
      description: "Free processing analysis for auto shops. See exactly what you'd save.",
    },
    instagram: {
      hook: "Your auto shop is probably losing $500 a month to your payment processor — and you don't even know it. [pause] Here's how to find out in 24 hours.",
      caption: "If {{businessName}} is running on Square or Clover, your flat-rate fees are costing you on every big repair invoice 🔧\n\nWe help auto shops in {{city}} cut processing costs by $400–$1,500/month — or eliminate them entirely with a cash discount program.\n\nFree statement analysis. No contract. Just the numbers.\n\n👉 Link in bio — get your free statement analysis today.\n\n#AutoShop #SmallBusiness #PaymentProcessing #{{city}}Business",
    },
    linkedin: "Hi {{firstName}}, I work with independent auto shops in {{city}} to reduce processing costs on high-ticket repair invoices. Most shops on Square or Clover are overpaying $400–$1,000/month. I'd love to offer {{businessName}} a complimentary statement analysis — no strings attached. Would you be open to a 10-minute comparison call?",
  },

  MedSpa: {
    facebook: {
      headline: "Med spas: recover $700–$2,500/month in processing fees",
      primaryText: "High-ticket treatments shouldn't mean high-ticket processing fees.\n\nIf {{businessName}} is processing through Square, Stripe, or Vagaro, you're likely paying 2.6–2.9% on every Botox appointment, laser treatment, and membership renewal.\n\nLiberty Bancard builds payment programs specifically for med spas — including cash discount programs that shift processing costs off your P&L entirely.\n\nFree statement analysis for {{city}} med spas. See exactly what you'd save.\n\n→ Get your free statement analysis.",
      description: "Med spa-specific payment processing. Cash discount + interchange-plus. Free analysis.",
    },
    instagram: {
      hook: "Your med spa is paying 2.7% on every $800 filler appointment. That's $21.60 per treatment going straight to your processor. [pause] Here's how to get it back.",
      caption: "Aesthetic practices deserve aesthetic pricing 💆‍♀️\n\nIf {{businessName}} is on Square, Stripe, or your booking software's built-in payments, you're likely losing $700–$2,500/month in unnecessary processing fees.\n\nWe help med spas in {{city}} with:\n→ Interchange-plus pricing (lower on high-ticket services)\n→ Cash discount programs (shift fees off your P&L)\n→ Membership recurring billing\n→ Jane, Vagaro, Mindbody + Zenoti integration\n\nFree statement analysis — link in bio.\n\n#MedSpa #AestheticBusiness #{{city}}MedSpa #SmallBusinessTips",
    },
    linkedin: "Hi {{firstName}}, I specialize in payment processing for aesthetic practices and med spas in {{city}}. Most practices on Square or Stripe are leaving $700–$2,500/month on the table — particularly on high-ticket services where flat-rate pricing really stings. I'd love to offer {{businessName}} a complimentary statement analysis. Would you have 10 minutes this week?",
  },

  Jewelry: {
    facebook: {
      headline: "Jewelry stores: stop paying 3% on $5,000 rings",
      primaryText: "On a $5,000 diamond sale, a 3% processing fee costs you $150. Multiply that across your monthly volume and it's a five-figure annual expense for {{businessName}}.\n\nLiberty Bancard specializes in high-ticket retail payment processing — including cash discount programs that shift processing costs to card-paying customers, legally and cleanly.\n\nJewelry retailers in {{city}} typically save $800–$2,000/month after switching.\n\nFree statement analysis. No commitment.\n\n→ Get your free statement analysis today.",
      description: "High-ticket retail payment processing. Interchange-plus + cash discount. Free analysis for jewelry stores.",
    },
    instagram: {
      hook: "Every $3,000 ring you sell on a credit card costs you $90 in processing fees at 3%. [pause] There's a legal way to get that back.",
      caption: "Your jewelry isn't generic — your payment processor shouldn't be either 💍\n\nIf {{businessName}} is on First Data, Fiserv, or a legacy processor, you're likely paying bundled rates that don't reflect the real interchange cost on your high-value inventory.\n\nWe help jewelry retailers in {{city}} with:\n→ Interchange-plus pricing (built for high-ticket retail)\n→ Cash discount programs (shift fees to card-paying customers)\n→ High-limit authorization support ($5K–$50K sales)\n→ Chargeback protection for luxury items\n\nFree statement analysis — link in bio.\n\n#JewelryStore #LuxuryRetail #{{city}}Business #PaymentProcessing",
    },
    linkedin: "Hi {{firstName}}, I work with high-ticket retailers and jewelry stores in {{city}} to reduce processing costs on large-value transactions. If {{businessName}} is on First Data or Fiserv, there's a good chance you're overpaying $800–$2,000/month. I'd love to offer a complimentary statement analysis — no strings attached. Would a 10-minute call work?",
  },

  Veterinary: {
    facebook: {
      headline: "Vet practices: reduce processing costs on emergency invoices",
      primaryText: "Emergency vet visits with $2,000–$8,000 invoices hit hard enough — you shouldn't also be overpaying on processing fees.\n\nIf {{businessName}} is processing through VetPay, Square, or your practice management software's built-in payments, you're likely on flat-rate pricing that doesn't account for your high-ticket, premium-card transaction mix.\n\nLiberty Bancard specializes in veterinary payment processing. Most practices save $500–$900/month after switching.\n\nFree statement analysis for {{city}} vet practices. No commitment.\n\n→ Get your free statement analysis.",
      description: "Veterinary payment processing. Interchange-plus optimized for vet practices. Free analysis.",
    },
    instagram: {
      hook: "VetPay charges you up to 3.2% on every payment — including that $4,000 emergency surgery. [pause] Here's what the number should actually be.",
      caption: "Your patients can't shop around on emergency care — but you can shop around on processing fees 🐾\n\nIf {{businessName}} is on VetPay, Square, or your practice software's built-in payments, you're likely losing $500–$900/month on unnecessary fees.\n\nWe help vet practices in {{city}} with:\n→ Interchange-plus pricing (optimized for your card mix)\n→ Large emergency invoice authorization support\n→ Avimark, eVetPractice + Cornerstone integration\n→ Same-day funding for supplies and meds\n\nFree statement analysis — link in bio.\n\n#VeterinaryPractice #VetLife #{{city}}Vets #SmallBusiness",
    },
    linkedin: "Hi {{firstName}}, I work with independent veterinary practices in {{city}} to reduce processing costs — particularly on the high-ticket emergency invoices that make up a significant part of most practice revenue. If {{businessName}} is on VetPay or Square, there's likely $500–$900/month in savings available. Would you be open to a complimentary statement analysis?",
  },

  Dental: {
    facebook: {
      headline: "Dental practices: $9,600/year in hidden processing fees",
      primaryText: "On $80K/month in dental card volume, the difference between 3% flat (what most dental software processors charge) and 2% interchange-plus is $800/month — $9,600 a year.\n\nIf {{businessName}} is processing through Dentrix, Eaglesoft, or another PMS's built-in payments, Liberty Bancard integrates directly — no workflow changes — at dramatically lower rates.\n\nFree statement analysis for {{city}} dental practices. See your exact savings in 24 hours.\n\n→ Get your free statement analysis.",
      description: "Dental practice payment processing. Dentrix + Eaglesoft integration. Interchange-plus pricing. Free analysis.",
    },
    instagram: {
      hook: "If your dental practice is processing $80K/month through Dentrix or Eaglesoft, you're probably paying $9,600/year more than you need to. [pause] Here's the math.",
      caption: "Your front desk doesn't need more friction — and your P&L doesn't need more fees 🦷\n\nIf {{businessName}} processes payments through Dentrix, Eaglesoft, or your PMS's built-in system, you're likely on 2.5–3.5% flat when interchange-plus pricing would cost 1.8–2.1%.\n\nOn $80K/month, that gap = $800/month = $9,600/year.\n\nWe integrate directly with your dental software. No workflow changes. No disruption.\n\nFree statement analysis for {{city}} dental practices — link in bio.\n\n#DentalPractice #Dentist #{{city}}Dentist #PracticeManagement",
    },
    linkedin: "Hi {{firstName}}, I specialize in payment processing for dental practices in {{city}}. On $80K/month in card volume, the difference between 3% flat and interchange-plus is $800/month — and we integrate directly with Dentrix and Eaglesoft, so there's no front-desk workflow change. I'd love to offer {{businessName}} a complimentary statement analysis. Would 10 minutes this week work?",
  },
};

// ─── Call Script ────────────────────────────────────────────────────────────────

const CALL_SCRIPT = `# The 5-Minute Comparison Call Script

## OPENING (30 seconds)

"Hi {{firstName}}, this is {{agentName}} from Liberty Bancard — thanks for taking a few minutes. Real quick, I want to make sure this is worth your time before we dive in. Do you currently accept credit and debit cards at your business?"

[Yes] → "Great. And roughly how much volume are you running through your processor each month? Ballpark is fine."

[Get a number] → "Perfect. And do you know offhand what your current effective rate is — meaning the actual percentage you're paying after all fees, not just the advertised rate?"

- If they know: note it and proceed.
- If they don't know: "No worries — most merchants don't. That's actually what I'm going to show you today."

---

## STATEMENT REVIEW (2 minutes)

"So here's the thing — most processors quote you one rate, but when you add up all the fees on your statement, the real number is usually 0.3% to 1% higher than what you think you're paying."

"For example, if you're on 2.6% flat and your actual effective rate after all fees is 3.2%, on $[their monthly volume] a month, that gap alone is $[calculate: volume × 0.006]/month — or $[annualize] a year."

**CALCULATION:** volume × (real rate – ideal rate) = monthly savings. Annualize × 12.

---

## THE COMPARISON (1 minute)

"Here's how our pricing works. We use interchange-plus pricing — that means you pay the actual Visa/Mastercard interchange rate plus a small, fixed markup. No bundled rates, no tiered surprises."

"For a business like yours, our all-in effective rate would typically run about:"
- Retail / Auto Shop: 1.9–2.3%
- Restaurant: 2.0–2.4%
- Healthcare / Dental / Vet: 1.8–2.2%
- Jewelry / High-ticket: 1.7–2.1%
- Med Spa: 1.8–2.2%

"And if you're open to a cash discount or dual-pricing program, we can get your net processing cost to near zero — legally, with full card-brand approval."

---

## THE CLOSE (30 seconds)

**If engaged and motivated:**
"The easiest next step is to forward me your last processing statement. I'll do the full analysis overnight and send you a side-by-side comparison. Takes you 2 minutes. Does that work?"

**If interested but cautious:**
"I'm not going to push you to make any decisions today. Let me just show you the numbers — if it makes sense, great; if not, at least you'll know exactly what you're paying. Can we get 10 minutes on the calendar this week?"

**If wants to think about it:**
"Totally understand. One quick question before I let you go — is it the timing that's not right, or is there something specific that would need to change for this to make sense?"`;

// ─── Objections ─────────────────────────────────────────────────────────────────

const OBJECTIONS = [
  {
    title: "I'm in a contract / I'll have an early termination fee.",
    reframe: "The merchant assumes switching costs more than staying. They haven't done the breakeven math.",
    reply: "What's your early termination fee? Because if we can save you $400–$800 a month, even a $495 ETF pays for itself in 30–60 days. Most merchants who switch mid-contract are cash-flow positive by month two. Can I run the breakeven on your statement?",
  },
  {
    title: "I'm happy with my current processor.",
    reframe: "Satisfaction doesn't mean they're getting a good deal — it usually means they haven't compared. Happy is not the same as optimized.",
    reply: "That's great — I'm not here to create a problem where there isn't one. But here's the thing: most merchants who tell me they're happy haven't looked at their effective rate in over a year. If an independent review confirms you're on good pricing, you'll know for sure. If it doesn't — you'll have missed $600–$1,200/month you could have kept. Would you let me do a 24-hour analysis, no strings attached?",
  },
  {
    title: "Your rates seem about the same as what I'm paying now.",
    reframe: "They're comparing advertised rates, not effective rates. The gap between the two is where merchants lose the most money.",
    reply: "The advertised rate is almost never the real number. What you're actually paying is your effective rate — that's total fees divided by total volume on your statement. Most merchants think they're at 2.5% and find out they're actually at 3.1–3.4% when you include all the fees. I can calculate your exact effective rate from your last statement in under 24 hours. Want me to show you the real number?",
  },
  {
    title: "I need to talk to my partner / accountant first.",
    reframe: "This is a legitimate request, not a brush-off. Make it easy for them to have the conversation by giving them the right materials.",
    reply: "Absolutely — I'd encourage that. Would it help if I put together a one-page savings summary showing your current effective rate versus what you'd pay with us, plus the annual dollar difference? Something concrete they can review without having to ask you to remember the details. That way the conversation is about the numbers, not the concept.",
  },
  {
    title: "I already tried switching processors once — it was a hassle.",
    reframe: "They had a bad experience and are risk-averse. Validate the experience, then differentiate your process.",
    reply: "That's completely fair — a bad setup experience can cost you days of disruption. What went wrong last time? [Listen.] Here's what we do differently: we handle the equipment setup, merchant account transfer, and software integration. Your team doesn't have to touch the technical side. Most switches go live within 48–72 hours, and we do a same-day call after go-live to make sure everything is clean.",
  },
];

// ─── Copy Button ────────────────────────────────────────────────────────────────

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ title: "Copied!", description: "Content copied to clipboard." });
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button variant="outline" size="sm" onClick={handleCopy} data-testid="button-copy">
      {copied ? <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-green-600" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
      {copied ? "Copied!" : label}
    </Button>
  );
}

// ─── Expandable Email Card ──────────────────────────────────────────────────────

function EmailCard({ seq }: { seq: EmailSequence }) {
  const [expanded, setExpanded] = useState(false);
  const preview = seq.body.split("\n").slice(0, 4).join("\n");

  return (
    <Card data-testid={`card-email-${seq.label}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <Badge variant="secondary" className="text-xs">{seq.label}</Badge>
            <p className="text-sm font-semibold text-foreground">Subject: {seq.subject}</p>
          </div>
          <CopyButton text={`Subject: ${seq.subject}\n\n${seq.body}`} label="Copy email" />
        </div>
      </CardHeader>
      <CardContent>
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
          {expanded ? seq.body : preview + (seq.body.length > preview.length ? "\n..." : "")}
        </pre>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 text-xs"
          onClick={() => setExpanded((e) => !e)}
          data-testid="button-toggle-email"
        >
          {expanded ? <><ChevronUp className="w-3 h-3 mr-1" />Collapse</> : <><ChevronDown className="w-3 h-3 mr-1" />Show full email</>}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export default function MarketingPlaybook() {
  const [selectedVertical, setSelectedVertical] = useState<Vertical>("Auto Shop");

  const emails = EMAIL_SEQUENCES[selectedVertical];
  const ads = SOCIAL_ADS[selectedVertical];

  return (
    <div className="space-y-6" data-testid="page-marketing-playbook">
      <div className="flex items-center gap-2">
        <Megaphone className="w-6 h-6 text-primary" />
        <h2 className="text-2xl font-bold" data-testid="heading-marketing-playbook">Marketing Playbook</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Daily actions, sequence map, content library, and call scripts in one place. Replit owns sequence timing and sending; the GHL workflow designs here are a reference.
      </p>

      {/* ─── Rep Daily Actions ─── */}
      <Card data-testid="card-rep-daily-actions">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CheckSquare className="w-4 h-4 text-primary" />
            <CardTitle className="text-base">Rep Daily Actions</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {REP_DAILY_ACTIONS.map((action, i) => {
              const Icon = action.icon;
              return (
                <li key={i} className="flex items-start gap-3" data-testid={`daily-action-${i}`}>
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${action.iconClass}`} />
                  <span className="text-sm">{action.text}</span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Tabs defaultValue="ghl-workflows">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="ghl-workflows" data-testid="tab-ghl-workflows">
            <Workflow className="w-3.5 h-3.5 mr-1.5" />
            GHL Workflows
          </TabsTrigger>
          <TabsTrigger value="email" data-testid="tab-email-templates">
            <Mail className="w-3.5 h-3.5 mr-1.5" />
            Content Library
          </TabsTrigger>
          <TabsTrigger value="social" data-testid="tab-social-ads">
            <Facebook className="w-3.5 h-3.5 mr-1.5" />
            Social Ads
          </TabsTrigger>
          <TabsTrigger value="script" data-testid="tab-call-script">
            <Phone className="w-3.5 h-3.5 mr-1.5" />
            Call Script
          </TabsTrigger>
          <TabsTrigger value="objections" data-testid="tab-objections">
            <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
            Objection Handling
          </TabsTrigger>
        </TabsList>

        {/* ─── GHL Workflows ─── */}
        <TabsContent value="ghl-workflows" className="mt-4 space-y-4">
          <GhlOwnershipNotice testId="notice-ghl-ownership-playbook" />
          <p className="text-sm text-muted-foreground">
            Six sequences cover every stage of the pipeline. Replit owns timing and sends (subject to the global outbound pause and each sequence's own pause state); sequence workflow IDs are reference-only (supported handoff workflows use their saved ID at enrollment). Reps focus on the actions below.
          </p>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto rounded-lg border" data-testid="table-ghl-workflows">
            <table className="w-full text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground w-8">#</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Workflow</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Trigger</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground w-16">Steps</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Timing</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Rep Action Required</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {GHL_WORKFLOWS.map((wf) => (
                  <tr key={wf.num} className="hover:bg-muted/30 transition-colors" data-testid={`row-workflow-${wf.num}`}>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="w-7 h-7 rounded-full flex items-center justify-center p-0 text-xs font-bold">
                        {wf.num}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-semibold">{wf.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{wf.trigger}</td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{wf.steps}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{wf.timing}</td>
                    <td className="px-4 py-3">{wf.repRole}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="grid gap-3 md:hidden">
            {GHL_WORKFLOWS.map((wf) => (
              <Card key={wf.num} data-testid={`card-workflow-${wf.num}`}>
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="w-7 h-7 rounded-full flex items-center justify-center p-0 text-xs font-bold shrink-0">
                      {wf.num}
                    </Badge>
                    <span className="font-semibold">{wf.name}</span>
                    <Badge variant="secondary" className="ml-auto">{wf.steps} steps</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground grid grid-cols-2 gap-1">
                    <span><span className="font-medium">Trigger:</span> {wf.trigger}</span>
                    <span><span className="font-medium">Timing:</span> {wf.timing}</span>
                  </div>
                  <div className="text-xs border-t pt-2">
                    <span className="font-medium text-primary">Rep:</span> {wf.repRole}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ─── Content Library (Email Templates) ─── */}
        <TabsContent value="email" className="space-y-4 mt-4">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium shrink-0">Vertical:</label>
            <Select value={selectedVertical} onValueChange={(v) => setSelectedVertical(v as Vertical)}>
              <SelectTrigger className="w-48" data-testid="select-vertical-email">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4">
            {emails.map((seq) => (
              <EmailCard key={seq.label} seq={seq} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Placeholders: <code className="bg-muted px-1 rounded">{"{{firstName}}"}</code>{" "}
            <code className="bg-muted px-1 rounded">{"{{businessName}}"}</code>{" "}
            <code className="bg-muted px-1 rounded">{"{{agentName}}"}</code>{" "}
            <code className="bg-muted px-1 rounded">{"{{agentEmail}}"}</code>{" "}
            <code className="bg-muted px-1 rounded">{"{{agentPhone}}"}</code>
          </p>
        </TabsContent>

        {/* ─── Social Ads ─── */}
        <TabsContent value="social" className="space-y-4 mt-4">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium shrink-0">Vertical:</label>
            <Select value={selectedVertical} onValueChange={(v) => setSelectedVertical(v as Vertical)}>
              <SelectTrigger className="w-48" data-testid="select-vertical-social">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            {/* Facebook */}
            <Card data-testid="card-facebook-ad">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Facebook className="w-4 h-4 text-blue-600" />
                  <CardTitle className="text-sm">Facebook Lead Form Ad</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Headline</p>
                    <CopyButton text={ads.facebook.headline} />
                  </div>
                  <p className="text-sm font-medium p-2 bg-muted rounded">{ads.facebook.headline}</p>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Primary Text</p>
                    <CopyButton text={ads.facebook.primaryText} />
                  </div>
                  <pre className="text-sm whitespace-pre-wrap p-2 bg-muted rounded font-sans leading-relaxed">{ads.facebook.primaryText}</pre>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</p>
                    <CopyButton text={ads.facebook.description} />
                  </div>
                  <p className="text-sm p-2 bg-muted rounded">{ads.facebook.description}</p>
                </div>
                <CopyButton
                  text={`Headline: ${ads.facebook.headline}\n\nPrimary Text:\n${ads.facebook.primaryText}\n\nDescription: ${ads.facebook.description}`}
                  label="Copy full ad"
                />
              </CardContent>
            </Card>

            {/* Instagram */}
            <Card data-testid="card-instagram-ad">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Instagram className="w-4 h-4 text-pink-600" />
                  <CardTitle className="text-sm">Instagram Reel Hook + Caption</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Reel Hook (first 3 seconds)</p>
                    <CopyButton text={ads.instagram.hook} />
                  </div>
                  <p className="text-sm p-2 bg-muted rounded italic">"{ads.instagram.hook}"</p>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Caption</p>
                    <CopyButton text={ads.instagram.caption} />
                  </div>
                  <pre className="text-sm whitespace-pre-wrap p-2 bg-muted rounded font-sans leading-relaxed">{ads.instagram.caption}</pre>
                </div>
              </CardContent>
            </Card>

            {/* LinkedIn */}
            <Card data-testid="card-linkedin-ad">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Linkedin className="w-4 h-4 text-blue-700" />
                  <CardTitle className="text-sm">LinkedIn Connection Request</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Message (300 char limit)</p>
                  <CopyButton text={ads.linkedin} />
                </div>
                <p className="text-sm p-2 bg-muted rounded">{ads.linkedin}</p>
                <p className="text-xs text-muted-foreground">Characters: {ads.linkedin.length} / 300</p>
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">
            Placeholders: <code className="bg-muted px-1 rounded">{"{{firstName}}"}</code>{" "}
            <code className="bg-muted px-1 rounded">{"{{businessName}}"}</code>{" "}
            <code className="bg-muted px-1 rounded">{"{{city}}"}</code>
          </p>
        </TabsContent>

        {/* ─── Call Script ─── */}
        <TabsContent value="script" className="mt-4">
          <Card data-testid="card-call-script">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">5-Minute Comparison Call Script</CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="button-print-script">
                  <Printer className="w-3.5 h-3.5 mr-1.5" />
                  Print
                </Button>
                <CopyButton text={CALL_SCRIPT} label="Copy script" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="max-w-none">
                {CALL_SCRIPT.split(/^(#{1,3} .+)$/m).map((chunk, i) => {
                  if (/^#{1,3} /.test(chunk)) {
                    const level = chunk.match(/^(#{1,3})/)?.[1].length ?? 1;
                    const text = chunk.replace(/^#{1,3} /, "");
                    if (level === 1) return <h2 key={i} className="text-base font-bold mt-4 mb-2 border-b pb-1">{text}</h2>;
                    if (level === 2) return <h3 key={i} className="text-sm font-bold mt-3 mb-1 text-primary">{text}</h3>;
                    return <h4 key={i} className="text-sm font-semibold mt-2 mb-1">{text}</h4>;
                  }
                  return (
                    <pre key={i} className="text-sm whitespace-pre-wrap font-sans leading-relaxed text-foreground bg-transparent m-0 p-0">
                      {chunk}
                    </pre>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Objection Handling ─── */}
        <TabsContent value="objections" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="grid-objections">
            {OBJECTIONS.map((obj, i) => (
              <Card key={i} data-testid={`card-objection-${i}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <Badge variant="outline" className="text-xs">Objection {i + 1}</Badge>
                      <CardTitle className="text-sm">{obj.title}</CardTitle>
                    </div>
                    <CopyButton text={`Objection: ${obj.title}\n\nReply: ${obj.reply}`} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Reframe</p>
                    <p className="text-xs text-muted-foreground italic">{obj.reframe}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Suggested Reply</p>
                    <p className="text-sm leading-relaxed">"{obj.reply}"</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
