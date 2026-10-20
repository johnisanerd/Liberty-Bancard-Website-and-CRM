import { useState, useMemo, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  CheckCircle2, Copy, ExternalLink, TrendingUp, Users, Mail, MessageSquare,
  Search, Youtube, Mic, Handshake, Star, Zap, Target, BookOpen, Globe,
  Phone, BarChart2, ArrowRight, Info, Rocket, DollarSign, Video, Radio,
  Building, Coffee, Award, ChevronDown, ChevronRight, Megaphone, Share2,
  Calculator, FileText, Gift, Linkedin, Instagram,
  Wrench, PlusCircle, Trash2, Download, LayoutGrid, ClipboardCheck,
  BarChart3, RefreshCw, PenLine, ListChecks, Repeat2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  label: string;
  detail?: string;
  template?: string;
  link?: string;
  linkLabel?: string;
  cost?: string;
  impact?: "high" | "medium" | "low";
  speed?: "immediate" | "weeks" | "months";
}

interface Section {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  description: string;
  weeklyTarget?: string;
  tasks: Task[];
}

// ─── Copy block ───────────────────────────────────────────────────────────────

function CopyBlock({ text, label }: { text: string; label?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  function handle() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      toast({ title: "Copied" });
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="relative group mt-2">
      {label && <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{label}</p>}
      <pre className="bg-muted/60 border rounded-md p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto max-h-48 overflow-y-auto">{text}</pre>
      <Button size="sm" variant="ghost" className="absolute top-2 right-2 h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={handle} aria-label="Copy">
        {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

// ─── Task card ────────────────────────────────────────────────────────────────

const IMPACT_COLOR: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};
const SPEED_COLOR: Record<string, string> = {
  immediate: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  weeks: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  months: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

function TaskCard({
  task, checked, onToggle,
}: { task: Task; checked: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border rounded-lg overflow-hidden transition-colors ${checked ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3 p-3 hover:bg-muted/30">
        <button
          className={`h-5 w-5 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors ${checked ? "bg-green-500 border-green-500" : "border-muted-foreground/40 hover:border-green-400"}`}
          onClick={onToggle}
          data-testid={`check-${task.id}`}
          aria-label="Toggle task"
        >
          {checked && <CheckCircle2 className="h-3.5 w-3.5 text-white" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-sm font-medium ${checked ? "line-through text-muted-foreground" : ""}`}>{task.label}</span>
            {task.cost && <Badge variant="outline" className="text-xs font-normal">{task.cost}</Badge>}
            {task.impact && <Badge className={`text-xs ${IMPACT_COLOR[task.impact]}`}>{task.impact} impact</Badge>}
            {task.speed && <Badge className={`text-xs ${SPEED_COLOR[task.speed]}`}>{task.speed}</Badge>}
          </div>
          {task.detail && !open && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.detail}</p>
          )}
        </div>
        {(task.detail || task.template || task.link) && (
          <button onClick={() => setOpen(!open)} className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        )}
      </div>
      {open && (task.detail || task.template || task.link) && (
        <div className="px-3 pb-3 border-t bg-muted/20 space-y-2 pt-2">
          {task.detail && <p className="text-xs text-muted-foreground leading-relaxed">{task.detail}</p>}
          {task.template && <CopyBlock text={task.template} label="Template / Copy" />}
          {task.link && (
            <a href={task.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
              <ExternalLink className="h-3 w-3" /> {task.linkLabel || task.link}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Playbook data ────────────────────────────────────────────────────────────

const SECTIONS: Section[] = [
  // ── CRO ──────────────────────────────────────────────────────────────────────
  {
    id: "cro",
    title: "Conversion Rate Optimization",
    icon: BarChart2,
    color: "border-red-500",
    description: "The cheapest growth lever. If your site converts at 2% and you get it to 4%, you've doubled signups without spending a dollar on acquisition. Fix this before anything else.",
    weeklyTarget: "+50–200 signups from existing traffic",
    tasks: [
      {
        id: "cro-1", label: "Change all primary CTA buttons to outcome-focused copy",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Replace 'Submit' and 'Get Started' with specific outcome language. Test: 'Get My Free Analysis', 'See How Much I'm Overpaying', 'Analyze My Statement Free'. Button copy is the single highest-leverage CRO change.",
        template: `Current → Replace with:\n"Submit" → "Get My Free Analysis"\n"Get Started" → "See How Much I'm Overpaying"\n"Learn More" → "Show Me the Savings"\n"Sign Up" → "Start My Free Review"\n"Contact Us" → "Talk to a Processing Expert"`,
      },
      {
        id: "cro-2", label: "Add a social proof bar above the fold on homepage",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Add a strip just below the hero: '3,200+ merchants analyzed | Average savings: $640/month | Reviews: ⭐⭐⭐⭐⭐ 4.9'. Real numbers build instant credibility and increase form submissions by 15–30%.",
      },
      {
        id: "cro-3", label: "Add trust badges to every form page",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Below every form add: PCI DSS Compliant | SSL Encrypted | BBB Accredited | No Contract Required | No Credit Card Needed. Hesitation at forms kills conversions. Trust badges reduce hesitation.",
      },
      {
        id: "cro-4", label: "Add urgency signal to the statement upload page",
        cost: "Free", impact: "medium", speed: "immediate",
        detail: "Add a line like: 'We review statements in order — current wait: under 24 hours.' Or: 'Our analysts reviewed 47 statements this week.' Creates scarcity and credibility without being fake.",
      },
      {
        id: "cro-5", label: "Add a 60-second explainer video to the homepage hero",
        cost: "Free (record on phone)", impact: "high", speed: "weeks",
        detail: "A founder-recorded 60-second video on the homepage explaining 'Here's exactly what we do and why it's free' increases conversions 20–40%. Script: 'Hi, I'm [name]. Here's the problem — most merchants don't know what they're actually paying in processing fees...' Record on iPhone in landscape mode. Informal > produced.",
        template: `Video script (60 sec):\n\n"Hi, I'm [Name] from Liberty Bancard.\n\nHere's the problem — most merchants are overpaying on payment processing fees. Not a little. A lot. But the way statements are formatted, it's almost impossible to tell.\n\nWe built a free analysis tool that takes your merchant statement and breaks it down in plain English. You'll see exactly what you're paying your processor in markup — and what you should be paying.\n\nNo sales call required. No obligation. Just upload your statement and we'll send you the full analysis within 24 hours.\n\nAverage savings for merchants who switch: $640/month.\n\nClick below to get your free analysis. Takes 2 minutes."`,
      },
      {
        id: "cro-6", label: "Reduce fields on the Free Analysis Quiz to name, email, phone only",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Every additional field reduces conversion by 5–10%. If you're asking for business type, volume, and current processor upfront — you're losing leads. Capture name/email/phone first, get the rest on the follow-up call or via GHL sequence.",
      },
      {
        id: "cro-7", label: "Make the statement upload link the ONLY CTA in your GHL email sequences",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Emails with one CTA get clicked 3x more than emails with multiple CTAs. Every sequence email should have one button: 'Upload My Statement'. Remove 'schedule a call', 'visit our website', etc. from the body. Those go in the P.S. or footer only.",
      },
      {
        id: "cro-8", label: "Add live chat / AI widget prominently on all high-intent pages",
        cost: "Free (GHL widget)", impact: "medium", speed: "immediate",
        detail: "Your GHL chat widget should appear on /upload-statement, /free-analysis, /get-started, and /estimate. Set the AI to proactively open with: 'Have a quick question about your merchant fees? I can answer it right now.' Proactive chat increases engagement 3–5x vs. passive.",
      },
      {
        id: "cro-9", label: "A/B test your homepage headline",
        cost: "Free", impact: "high", speed: "weeks",
        detail: "Run two versions for 2 weeks each and compare form submission rates.",
        template: `Headline variants to test:\n\nVariant A: "Stop Overpaying on Credit Card Processing"\nVariant B: "Most Merchants Are Overpaying by $640/Month. Are You?"\nVariant C: "We'll Tell You Exactly What You're Paying in Processing Fees — Free"\nVariant D: "Upload Your Statement. We'll Find the Savings in 24 Hours."\n\nTest one at a time. Use Hotjar (free) to see where users drop off.`,
      },
      {
        id: "cro-10", label: "Install Hotjar free heatmaps on your 3 main conversion pages",
        cost: "Free tier", impact: "medium", speed: "immediate",
        detail: "Hotjar shows you exactly where users click, scroll, and drop off. Install on /upload-statement, /free-analysis, and homepage. Review after 500 sessions. You will find at least 2–3 things to fix immediately.",
        link: "https://www.hotjar.com", linkLabel: "Install Hotjar Free",
      },
    ],
  },

  // ── PHASE 1 ───────────────────────────────────────────────────────────────────
  {
    id: "phase1",
    title: "Phase 1 — Zero-Cost Quick Wins (Weeks 1–4)",
    icon: Zap,
    color: "border-yellow-500",
    description: "Every item here costs nothing. All of these can be started this week and start producing signups within days.",
    weeklyTarget: "50–150 signups/week",
    tasks: [
      {
        id: "p1-1", label: "Claim and fully optimize Google Business Profile",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "GBP is your #1 free local lead source. 'Merchant services near me' and 'payment processing [city]' convert at 15–25%. A complete profile drives 20–60 inbound leads/week within 30 days.",
        template: `GBP Setup Checklist:\n□ Claim listing at business.google.com\n□ Category: "Payment Service" + "Financial Institution"\n□ Add all services: Merchant Services, Payment Processing, POS Systems, Cash Discount Program, Surcharge Program, Statement Review, Credit Card Processing, 0% Processing\n□ Upload 10+ photos (office, team, terminals, logo)\n□ Write 750-char description (include "payment processing", "merchant services", "interchange-plus", "[your city]")\n□ Add primary CTA: "Get a Free Analysis" → /upload-statement\n□ Add phone, hours, website\n□ Set up Google Posts (post weekly — same as LinkedIn)\n□ Enable messaging\n□ Respond to every review within 24 hours`,
        link: "https://business.google.com", linkLabel: "Claim Google Business Profile",
      },
      {
        id: "p1-2", label: "Submit to all free business directories (one-time, 4 hours)",
        cost: "Free", impact: "medium", speed: "weeks",
        detail: "Each listing = permanent backlink + lead source. Do all of these in one sitting.",
        template: `Directory submission list (all free tiers):\n\n1. Google Business Profile — business.google.com\n2. Yelp Business — biz.yelp.com\n3. Better Business Bureau — bbb.org/accreditation\n4. Capterra — capterra.com/vendors (list under "Payment Processing")\n5. G2 — g2.com/products/new\n6. GetApp — getapp.com\n7. Trustpilot — business.trustpilot.com (free plan)\n8. Clutch.co — clutch.co/get-listed\n9. Angi (for contractor/trades merchants) — angi.com\n10. Apple Maps — mapsconnect.apple.com\n11. Bing Places — bingplaces.com\n12. Chamber of Commerce — chamberofcommerce.com/add-business\n13. Manta — manta.com\n14. Foursquare — foursquare.com/business\n15. Hotfrog — hotfrog.com\n\nFor each listing:\n- Use exact same NAP (Name, Address, Phone) everywhere\n- Description: include "payment processing", "merchant services", "credit card processing"\n- Link always to /upload-statement`,
      },
      {
        id: "p1-3", label: "Activate your existing referral program — email all merchants NOW",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Your affiliate program is built but sitting idle. One email blast to your existing merchant base asking for one referral can produce 20–50 leads within 48 hours.",
        template: `Subject: Quick favor — know another business owner? (There's something in it for you)\n\nHi [First Name],\n\nYou've been with Liberty Bancard and hopefully you've seen the savings on your processing.\n\nSimple ask: if you know one other business owner who's frustrated with their payment processing fees — and who wouldn't be? — I'd love an introduction.\n\nFor every merchant you refer who signs up, we'll send you $100 as a thank you. No limit on referrals.\n\nYour personal referral link:\n[REFERRAL_LINK]\n\nJust forward this email to them, or share the link. That's it.\n\nThank you for the trust.\n\n— [Name]\nLiberty Bancard`,
      },
      {
        id: "p1-4", label: "Add referral link to every outbound email footer permanently",
        cost: "Free", impact: "medium", speed: "immediate",
        detail: "Add to your GHL email signature and every outbound sequence: 'Know a business owner paying too much on processing? Refer them → [link]. We'll send you $100 when they sign up.' Passive but compounds forever.",
        template: `Email footer add-on:\n\n---\nKnow a business owner paying too much on processing?\nRefer them here → [REFERRAL_LINK]\nWe'll send you $100 when they sign up. No catch.`,
      },
      {
        id: "p1-5", label: "Start posting on LinkedIn 3x/week — founder account",
        cost: "Free", impact: "high", speed: "weeks",
        detail: "LinkedIn is the #1 free B2B lead channel right now. Merchant services content with real numbers gets 5,000–50,000 views per post. The key: educational, specific, no sales pitch.",
        template: `LinkedIn post formats that perform:\n\n--- FORMAT 1: Statement Teardown ---\n"I reviewed a restaurant's merchant statement today.\n\nHere's what I found:\n• Total processing volume: $87,400\n• Interchange (base cost): $1,486\n• Processor markup: $1,223 ← This is the problem\n• Effective rate: 3.10%\n• What they should be paying: 2.24%\n\nThat's $756/month in unnecessary fees.\n$9,072/year.\n\nAnd they had no idea.\n\nIf you accept credit cards and haven't reviewed your statement in the last 12 months — when was the last time you looked at what your processor is actually making off you?\n\n[Upload link in first comment]"\n\n--- FORMAT 2: Myth Bust ---\n"'My rates are fine.'\n\nI hear this from merchants every week.\n\nHere's the thing: your processor has no incentive to tell you when you're overpaying. The fee statement is designed to be confusing. Interchange, assessments, non-qualified surcharges — most merchants don't know what any of this means.\n\nFree offer: send me your statement and I'll tell you in plain English exactly what you're paying — and what you should be paying.\n\nNo pitch. Just numbers."\n\n--- FORMAT 3: Case study ---\n"We got a dental office from 2.9% to 1.8% last week.\n\nVolume: $42,000/month\nOld cost: $1,218\nNew cost: $756\nMonthly savings: $462\nAnnual savings: $5,544\n\nTime it took: 48 hours to review, 5 days to switch.\n\nThey thought switching processors was complicated. It wasn't.\n\nAny questions about your own rates? Drop them in the comments."`,
      },
      {
        id: "p1-6", label: "Monitor and answer Reddit threads daily (30 min/day)",
        cost: "Free", impact: "medium", speed: "weeks",
        detail: "Set up Reddit search alerts for payment processing questions. Be the expert. Never post links in the post — add them in comments after 2–3 genuine answers.",
        template: `Subreddits to monitor daily:\n• r/smallbusiness — search: "processing fees" "merchant services" "credit card fees"\n• r/entrepreneur — same searches\n• r/restaurantowners\n• r/Dentistry\n• r/MedSpa\n• r/AutoMechanic\n• r/Flipping\n• r/ecommerce\n\nHow to respond:\n1. Answer the question genuinely and specifically\n2. Include real numbers when possible\n3. At the END, after helping: "I do statement reviews for free at Liberty Bancard if you want an actual analysis — link in my bio"\n4. NEVER lead with a sales pitch\n\nSample response to "Are my processing fees too high?":\n"Hard to say without seeing the statement, but here's how to figure it out yourself: take your total processing fees for the month and divide by total volume. That's your effective rate. Industry average by type:\n• Restaurant: 2.2–2.8%\n• Retail: 1.9–2.5%\n• Medical: 2.0–2.6%\n• E-commerce: 2.5–3.2%\nIf you're above those, you're likely overpaying. Happy to look at your statement if you want a real breakdown."`,
      },
      {
        id: "p1-7", label: "Join and contribute to 10 local/industry Facebook groups",
        cost: "Free", impact: "medium", speed: "weeks",
        detail: "Search Facebook for '[your city] small business owners', 'restaurant owners [state]', 'dental practice management', etc. Join, participate for 1 week before mentioning Liberty Bancard. Be a resource, not an ad.",
        template: `Facebook groups to search and join:\n□ "[City] Small Business Owners"\n□ "[City] Entrepreneurs"\n□ "Restaurant Owners [State]"\n□ "Dental Practice Management"\n□ "Med Spa Owners"\n□ "Auto Repair Shop Owners"\n□ "Retail Business Owners"\n□ "I Hate My Merchant Processor" (yes, these exist)\n□ "Small Business Support Group"\n□ "[Industry] Business Networking"\n\nStrategy:\n• Week 1: Introduce yourself, answer 3–5 questions, NO pitch\n• Week 2+: When processing fees come up, offer a free review\n• Post educational content: "Here's how to read your merchant statement" with infographic`,
      },
      {
        id: "p1-8", label: "Text all existing merchants a referral ask (GHL SMS blast)",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Send one text to every existing merchant. Short, personal, direct.",
        template: `SMS: "Hi [Name], Liberty Bancard here. Quick ask — do you know another business owner frustrated with their processing fees? If they sign up through your referral link, we'll send you $100. [REFERRAL_LINK] Reply STOP to opt out."`,
      },
    ],
  },

  // ── PHASE 2 ───────────────────────────────────────────────────────────────────
  {
    id: "phase2",
    title: "Phase 2 — Content Engine (Weeks 4–12)",
    icon: BookOpen,
    color: "border-blue-500",
    description: "Build the assets that compound over time. SEO, video, and partner recruitment produce signups while you sleep. Takes 60–90 days to start ranking but lasts forever.",
    weeklyTarget: "150–400 signups/week",
    tasks: [
      {
        id: "p2-1", label: "Publish 2 SEO blog posts per week targeting high-volume keywords",
        cost: "Free (write yourself or use AI draft + edit)", impact: "high", speed: "months",
        detail: "Your blog infrastructure is already built. These posts will start ranking in 60–90 days and drive traffic permanently. Target one keyword per post. Format: 1,500–2,500 words, real examples, numbered steps, FAQ section. Every post ends with a CTA to /upload-statement.",
        template: `Priority blog post list (publish in this order):\n\n1. "How to Read a Merchant Statement (Step-by-Step Guide)" — 1,900 searches/mo\n2. "Average Credit Card Processing Fees by Industry [2025]" — 6,600/mo\n3. "What is Interchange-Plus Pricing?" — 2,400/mo\n4. "Cash Discount Program: Complete Guide for Merchants" — 2,900/mo\n5. "How to Switch Payment Processors Without Losing Sales" — 1,300/mo\n6. "Square vs Interchange-Plus: Which Saves More?" — 880/mo\n7. "What is a Surcharge Program? Is It Legal?" — 1,600/mo\n8. "Hidden Fees in Merchant Agreements (What to Watch For)" — 1,100/mo\n9. "Best Payment Processor for Restaurants [2025]" — 3,200/mo\n10. "Best Payment Processor for Dental Offices [2025]" — 590/mo\n11. "How to Negotiate Lower Credit Card Processing Fees" — 720/mo\n12. "0% Credit Card Processing Explained" — 4,400/mo\n13. "What is an Effective Rate on a Merchant Statement?" — 480/mo\n14. "Early Termination Fees: Can You Get Out of Your Merchant Contract?" — 590/mo\n15. "Stripe vs Interchange-Plus Pricing" — 1,200/mo\n16. "Best Payment Processor for Med Spas" — 320/mo\n17. "How Long Does It Take to Switch Payment Processors?" — 720/mo\n18. "PCI Compliance for Small Businesses: What You Actually Need to Do" — 1,800/mo\n19. "What is Interchange Fee? (Plain English Explanation)" — 2,100/mo\n20. "Merchant Services Contracts: What to Read Before You Sign" — 640/mo\n\nEach post formula:\n• H1: Target keyword\n• Intro: Agitate the problem (most merchants don't know...)\n• Body: Genuinely useful information, numbered steps\n• FAQ section (5–7 questions — generates Google rich snippets)\n• CTA: "Want to see where you stand? Upload your statement for a free 24-hour analysis → [link]"`,
      },
      {
        id: "p2-2", label: "Launch YouTube channel — 1 video per week",
        cost: "Free (phone camera)", impact: "high", speed: "months",
        detail: "YouTube is the second largest search engine. Payment processing content has almost zero competition. You can rank #1 for dozens of terms within 90 days. 5–12 minute educational videos, screen shares, real statement walkthroughs.",
        template: `First 10 YouTube videos (publish in this order):\n\n1. "I Reviewed Your Merchant Statement — Here's What I Found" (screen share)\n2. "The 5 Fees Your Processor Hopes You Never Find"\n3. "Cash Discount Program Explained in 5 Minutes"\n4. "How to Switch Payment Processors (Without Losing a Day of Sales)"\n5. "What's a Good Effective Rate? Breaking Down the Math"\n6. "Square vs Interchange Plus: Live Comparison on Real Numbers"\n7. "How We Saved a Restaurant $800/Month in 48 Hours"\n8. "Is Your Processor Ripping You Off? Here's How to Tell in 3 Minutes"\n9. "Merchant Services Red Flags to Watch For"\n10. "0% Processing: How Cash Discount Works (and What Customers Think)"\n\nVideo format:\n• Record on iPhone, landscape, ring light ($25) or near window\n• Screen share for statement walkthroughs (OBS free)\n• 5–12 minutes optimal\n• End card: "Upload your statement at libertybancard.com/upload-statement for a free review"\n• Description: full keyword-rich description + link in first line\n• Post to YouTube, clip 60-sec version for LinkedIn + Instagram Reels + TikTok`,
      },
      {
        id: "p2-3", label: "Recruit 50 CPA and bookkeeper partners in 60 days",
        cost: "Free (LinkedIn + email)", impact: "high", speed: "months",
        detail: "One CPA with 50 small business clients can refer 5–15 merchants/year. 50 CPAs = 250–750 referrals/year. This is your highest-leverage channel at scale because referrals convert at 40–60% vs. 2–5% for cold traffic.",
        template: `LinkedIn outreach to CPAs/bookkeepers:\n\nConnection request note:\n"Hi [Name] — I see you work with small business owners. I run a merchant services company and think there might be some overlap. Would love to connect."\n\nFollow-up message after connecting (day 3):\n"Thanks for connecting. Quick question — do your clients ever ask you about their payment processing fees? It comes up a lot with mine.\n\nWe've built a pretty straightforward partner program: you refer a client for a free statement review, and if they end up switching to us, we pay you 30% of our monthly revenue from that merchant — every month, for as long as they're a client.\n\nNo extra work. No sales pitch required on your end — just the referral. Average partner earns $200–$600/month within 6 months.\n\nWould you be open to a 10-minute call to see if it's a fit?"\n\nWho to target on LinkedIn:\n• Search: "CPA" + "[your state]" + "small business"\n• Search: "bookkeeper" + "QuickBooks ProAdvisor"\n• Search: "business accountant" + "restaurant" or "dental" or "retail"\n\nOther outreach channels:\n• Email CPA firms directly (find via Google: "CPA firm [city]")\n• Attend SCORE and SBA events\n• Join your local Chamber of Commerce and meet CPAs there`,
      },
      {
        id: "p2-4", label: "Recruit insurance agents and commercial brokers as partners",
        cost: "Free", impact: "medium", speed: "months",
        detail: "Business insurance agents talk to every small business owner. Commercial real estate brokers work with businesses opening new locations. Both are natural referral sources.",
        template: `Outreach to insurance agents:\n\n"Hi [Name],\n\nI noticed you work with small business owners on their insurance needs. Quick question: do your clients ever mention frustration with their payment processing costs? It comes up constantly in my world.\n\nWe offer a free statement review that shows merchants exactly what they're overpaying — no obligation. For every client you refer who switches to us, we pay you $150–$300 one-time (depending on volume).\n\nNo selling required on your end. Just a mention or a forward of our analysis page.\n\nWould this be useful for your clients?"\n\nTarget:\n• Independent insurance agents (not captive agents)\n• Commercial RE brokers\n• Business attorneys (incorporations)\n• SBA/SCORE mentors\n• Franchise brokers`,
      },
      {
        id: "p2-5", label: "Build an email newsletter — 'The Processing Insider' (weekly)",
        cost: "Free (use GHL)", impact: "medium", speed: "months",
        detail: "A weekly email to your list that teaches merchants one thing about payment processing. Builds authority, keeps Liberty Bancard top of mind, generates referrals over time. Use GHL for delivery.",
        template: `Newsletter format (weekly, 300–500 words):\n\nSubject line formats:\n• "The fee your processor buried in your statement this month"\n• "What a 2.9% rate actually costs a restaurant doing $80K/month"\n• "One question that can lower your processing rate immediately"\n\nBody format:\n1. ONE insight or tip (real numbers, real examples)\n2. One brief case study or result\n3. One CTA: "Forward this to a business owner who should see it" OR link to upload statement\n\nGrow the list:\n• Add newsletter signup to blog posts\n• Offer "The Merchant Statement Decoder" PDF as signup incentive\n• Add to GHL sequence for all leads who don't convert immediately`,
      },
      {
        id: "p2-6", label: "Create 'The Merchant Statement Decoder' PDF lead magnet",
        cost: "Free (Canva)", impact: "high", speed: "weeks",
        detail: "A 1-page visual guide explaining every line item on a merchant statement in plain English. CPAs love forwarding these to clients. Put it behind an email gate on blog posts. Offer it in Facebook groups freely.",
        template: `PDF sections:\n\n"The Merchant Statement Decoder"\n\n1. Interchange Fees — What they are, who sets them (Visa/MC, not your processor), why they're not negotiable\n2. Assessment Fees — Small % set by card networks. Also not negotiable.\n3. Processor Markup — THIS is the negotiable part. Everything above interchange + assessment\n4. How to calculate your Effective Rate: Total fees ÷ Total volume = Effective Rate %\n5. Average effective rates by industry (chart)\n6. Red flags: non-qualified surcharges, batch fees, statement fees, PCI non-compliance fees\n7. CTA: "Want us to decode YOUR statement? Free 24-hour analysis at [link]"\n\nCreate in Canva (free). One page. Make it beautiful and shareable.`,
        link: "https://www.canva.com", linkLabel: "Create in Canva (free)",
      },
      {
        id: "p2-7", label: "Post on Quora — answer payment processing questions",
        cost: "Free", impact: "medium", speed: "months",
        detail: "Quora answers rank in Google. A well-written answer to 'How can I lower my credit card processing fees?' can get 10,000+ views and drive traffic for years.",
        template: `Quora questions to search and answer:\n• "How can I reduce credit card processing fees for my small business?"\n• "What is interchange-plus pricing?"\n• "Is Square good for small businesses?"\n• "How do I read my merchant statement?"\n• "What is a cash discount program?"\n• "Are merchant services fees negotiable?"\n• "How do I switch payment processors?"\n\nAnswer format:\n1. Lead with the most useful answer immediately (no preamble)\n2. Include specific numbers and examples\n3. At end: "Full disclosure — I work in merchant services. Happy to answer follow-up questions or review a statement for free."\n4. Add your profile link to /upload-statement`,
      },
    ],
  },

  // ── PR & EARNED MEDIA ─────────────────────────────────────────────────────────
  {
    id: "pr",
    title: "PR & Earned Media",
    icon: Megaphone,
    color: "border-purple-500",
    description: "Free press is the highest-credibility traffic source. One article in a local business journal can drive hundreds of signups. HARO is free and can land national press.",
    weeklyTarget: "+20–100 signups per mention",
    tasks: [
      {
        id: "pr-1", label: "Sign up for HARO and respond to journalist queries daily",
        cost: "Free", impact: "high", speed: "weeks",
        detail: "HARO (Help a Reporter Out) sends 3 emails/day with journalists looking for expert sources. Payment processing, small business costs, fintech — these categories come up weekly. One quote in Forbes, Inc., or Business Insider drives hundreds of signups and permanent backlinks.",
        template: `HARO response template:\n\nSubject: RE: [Exact query title]\n\nHi [Name],\n\nI'm [Name], [title] at Liberty Bancard, a merchant payment processing company that has reviewed 3,200+ merchant statements.\n\n[Answer their specific question in 2–3 paragraphs with real numbers and insight — not a sales pitch]\n\nFor context: [add one specific, credible data point from your experience]\n\nI'm available for follow-up questions at [email] or [phone].\n\n[Name]\n[Title] | Liberty Bancard\nwww.libertybancard.com\n[Phone]\n\nBio: [2 sentences max]`,
        link: "https://www.connectively.us", linkLabel: "Sign up for HARO (now Connectively)",
      },
      {
        id: "pr-2", label: "Pitch local business journals and newspapers",
        cost: "Free", impact: "medium", speed: "weeks",
        detail: "Local business press loves 'local company helps small businesses save money' stories — especially with real numbers. One article in your local business journal can drive 50–200 signups.",
        template: `Pitch email to local business journal editor:\n\nSubject: Local merchant services company saving FL small businesses $640/month — story idea\n\nHi [Editor Name],\n\nI wanted to pitch a story that I think would resonate with your readers.\n\nWe're a [city]-based merchant services company that reviews payment processing statements for small businesses — for free. We've done 3,200+ reviews and the average business we analyze is overpaying by $640/month.\n\nMost merchants have no idea. Their statement is designed to be confusing.\n\nI think there's a great reader story here — especially for the restaurants, retailers, and service businesses your readers know.\n\nI can provide:\n• Before/after numbers from local merchants (with their permission)\n• A plain-English explanation of how merchant fees actually work\n• A free analysis offer exclusive to your readers\n\nWould you be open to a 15-minute call to explore?\n\n[Name]\n[Title] | Liberty Bancard\n[Phone]`,
      },
      {
        id: "pr-3", label: "Submit free press releases to PR distribution sites",
        cost: "Free", impact: "low", speed: "weeks",
        detail: "Free PR sites have limited reach but each is a permanent backlink and indexed article.",
        template: `Free PR distribution sites:\n• PRLog.com (free)\n• PRFree.com (free)\n• OpenPR.com (free)\n• 24-7PressRelease.com (free tier)\n• IssueWire.com (free tier)\n\nPress release angles:\n• "Liberty Bancard Launches Free Merchant Statement Analysis — Helping FL Businesses Recover Hidden Fees"\n• "Local Payment Processor Saves Small Businesses Average $640/Month on Credit Card Fees"\n• "Liberty Bancard Opens ISO Partner Program, Offering 30% Residual Commission to Financial Advisors"`,
      },
      {
        id: "pr-4", label: "Get quoted in industry trade publications",
        cost: "Free", impact: "medium", speed: "months",
        detail: "Trade publications for restaurants, dental, retail, auto repair all need expert sources. Reach out proactively.",
        template: `Target trade publications by vertical:\n\nRestaurant:\n• Nation's Restaurant News — nrn.com\n• Restaurant Business — restaurantbusinessonline.com\n• QSR Magazine — qsrmagazine.com\n\nDental:\n• Dental Economics — dentaleconomics.com\n• Dental Products Report — dentalproductsreport.com\n\nRetail:\n• Retail Dive — retaildive.com\n• Chain Store Age — chainstoreage.com\n\nAuto Repair:\n• Motor Age — motorage.com\n• Ratchet+Wrench — ratchetandwrench.com\n\nPitch angle for each:\n"[Industry] businesses are overpaying on payment processing — here's what they should know about their merchant statement"\n\nOffer to write a guest column or provide expert comment.`,
      },
      {
        id: "pr-5", label: "Build a 'Media' page on your website with data and story hooks",
        cost: "Free", impact: "medium", speed: "weeks",
        detail: "Journalists Google companies before reaching out. A /media page with stats, founder bios, and press-ready quotes makes you look credible and makes their job easier.",
        template: `Media page content:\n• Key stats: "3,200+ statements reviewed | $640 avg monthly savings found | [N] merchants helped"\n• Founder bio (2–3 paragraphs)\n• High-res headshots and logo downloads\n• Press quotes / previous coverage\n• 3–5 story angles journalists can pitch\n• Contact: press@libertybancard.com`,
      },
    ],
  },

  // ── PODCAST & VIDEO ───────────────────────────────────────────────────────────
  {
    id: "podcast",
    title: "Podcast Guesting & Video",
    icon: Radio,
    color: "border-pink-500",
    description: "Podcast appearances are 100% free and put you in front of engaged audiences who trust the host. One appearance on a small business podcast can drive 50–300 signups.",
    weeklyTarget: "+20–100 signups per appearance",
    tasks: [
      {
        id: "pod-1", label: "Pitch 20 small business podcasts as a guest expert",
        cost: "Free", impact: "high", speed: "weeks",
        detail: "There are thousands of small business podcasts with audiences of exactly your target customer. You don't need the biggest shows — a podcast with 5,000 engaged restaurant owner listeners is more valuable than one with 100,000 generic listeners.",
        template: `Podcast pitch email:\n\nSubject: Guest pitch: "What's hiding in your merchant statement" — payment processing expert\n\nHi [Host Name],\n\nI listen to [Podcast Name] regularly — [specific reference to a recent episode or topic].\n\nI run Liberty Bancard, a merchant payment processing company. I think I can offer your listeners something genuinely useful: a plain-English breakdown of how payment processing fees actually work and what most small business owners are unknowingly overpaying.\n\nThree angles that tend to resonate with small business audiences:\n\n1. "The one fee on your merchant statement your processor hopes you ignore"\n2. "How to tell in 5 minutes if you're overpaying on credit card processing"\n3. "The Cash Discount Program: what it is, how it works, and whether it's right for your business"\n\nI can bring real numbers and real examples. No sales pitch — just useful information your listeners can act on.\n\nWould you be open to a quick call to see if it's a fit?\n\n[Name] | Liberty Bancard | [Phone]\n\nP.S. Happy to offer your listeners a free statement review as a listener exclusive.\n\n---\nPodcasts to target:\n• Smart Passive Income\n• My First Million\n• The Restaurant Guys\n• Restaurant Unstoppable\n• Dental Practice Heroes\n• Dental Drill Bits\n• Automotive Management Network\n• Retail Leadership Podcast\n• The Small Business Radio Show\n• How to Scale a Small Business\n• Entrepreneurs on Fire\n• The $100 MBA Show`,
      },
      {
        id: "pod-2", label: "Clip every YouTube video for TikTok, Instagram Reels, and LinkedIn",
        cost: "Free (CapCut)", impact: "medium", speed: "weeks",
        detail: "Each 10-minute YouTube video = 5–8 clips of 30–60 seconds. Post each clip across all platforms. Use CapCut (free) to add captions and edit. Captions increase views 40%.",
        template: `Clip strategy:\n\nFrom each full YouTube video, extract:\n• 1 × 60-sec "hook" clip (the most surprising stat or revelation)\n• 1 × 30-sec "tip" clip (one actionable takeaway)\n• 1 × 45-sec "case study" clip (before/after numbers)\n\nPlatform distribution:\n• TikTok: Post all clips. Use #smallbusiness #merchantservices #creditcardfees\n• Instagram Reels: Same clips. Tag local business accounts\n• LinkedIn: Post clips as native video (not YouTube links)\n• Facebook Business page: Post all clips\n\nCaption format for all short-form:\nLine 1: Bold hook ("Your processor made $1,200 off you last month.")\nLine 2-3: Setup\nLine 4+: Payoff / lesson\nFinal line: "Free statement review → link in bio"`,
      },
      {
        id: "pod-3", label: "Host one free 'Slash Your Processing Fees' webinar per month",
        cost: "Free (Zoom free tier)", impact: "high", speed: "weeks",
        detail: "A 30-minute free webinar teaching merchants how to read their statement is both a lead magnet and a conversion tool. At the end, offer a free analysis for every attendee. Target 20–50 attendees. Even 10 attendees = 2–5 new merchants if you present well.",
        template: `Webinar structure (30 minutes):\n\n0:00 — Intro (2 min)\n"Welcome. I'm [Name] from Liberty Bancard. In the next 30 minutes I'm going to show you exactly how to read your merchant statement and find out if you're overpaying — and how much."\n\n2:00 — The problem (5 min)\nHow processor fees work. Why statements are confusing by design. Show a real statement (redacted).\n\n7:00 — The breakdown (10 min)\nLive walkthrough: here's interchange, here's assessment, here's the markup. Show effective rate calculation.\n\n17:00 — Real case studies (5 min)\n2–3 before/after examples with real numbers.\n\n22:00 — Q&A (5 min)\n\n27:00 — Close (3 min)\n"Every person on this call can get a free statement review. Just go to [link] and upload yours. We'll send you the full breakdown within 24 hours."\n\nPromotion:\n• LinkedIn post + event\n• Email existing list\n• Post in Facebook groups\n• Eventbrite free listing\n• Partner CPAs can invite their clients`,
      },
    ],
  },

  // ── STRATEGIC PARTNERSHIPS ────────────────────────────────────────────────────
  {
    id: "partnerships",
    title: "Strategic Partnerships & Integrations",
    icon: Handshake,
    color: "border-emerald-500",
    description: "The highest-leverage partnerships put you in front of merchants at the exact moment they're thinking about their finances — inside the tools they already use every day.",
    weeklyTarget: "+50–200 signups/week at maturity",
    tasks: [
      {
        id: "part-1", label: "Apply to QuickBooks ProAdvisor referral network",
        cost: "Free", impact: "high", speed: "months",
        detail: "QuickBooks has millions of small business users. The ProAdvisor community is full of bookkeepers and accountants who can refer merchants. Getting listed as a recommended payment processor for QuickBooks users is a major lead channel.",
        link: "https://quickbooks.intuit.com/accountants/proadvisor/", linkLabel: "QuickBooks ProAdvisor Program",
      },
      {
        id: "part-2", label: "Apply to Xero Partner Program",
        cost: "Free", impact: "medium", speed: "months",
        detail: "Xero is used by 3M+ small businesses. Their partner directory gets searched by merchants looking for payment solutions.",
        link: "https://www.xero.com/us/partners/", linkLabel: "Xero Partner Program",
      },
      {
        id: "part-3", label: "Partner with local POS system resellers",
        cost: "Free", impact: "medium", speed: "months",
        detail: "POS resellers (Clover dealers, PAX dealers, Toast resellers) are talking to merchants who need processing. Offer a referral fee for every merchant they send who signs up.",
        template: `POS reseller partnership pitch:\n\n"Hi [Name],\n\nI run Liberty Bancard — we focus purely on the processing side while you handle the hardware. I think we could send each other a lot of business.\n\nEvery merchant you install hardware for needs processing. We offer interchange-plus pricing that's typically 0.5–1% lower than what the hardware company's default processor charges.\n\nWe pay $150–$300 per successful merchant referral.\n\nAnd vice versa — when our merchants need new equipment, we refer them to you.\n\nWould you be open to a quick call?"`,
      },
      {
        id: "part-4", label: "Approach SCORE and SBA with a free merchant education offer",
        cost: "Free", impact: "medium", speed: "months",
        detail: "SCORE mentors advise thousands of small businesses. SBA offices run workshops. Offer to do a free 30-min 'Understanding Your Payment Processing Costs' session for their clients. You become the de facto expert they refer to.",
        template: `SCORE/SBA email pitch:\n\n"Hi [Name],\n\nI work with small business owners on payment processing and I've noticed that understanding merchant fees is a consistent knowledge gap — most business owners have no idea what they're actually paying.\n\nI'd love to offer your clients a free 30-minute workshop: 'How to Read Your Merchant Statement and Find Hidden Fees.' No sales pitch — purely educational.\n\nIn my experience, this is one of the highest-ROI sessions for small business owners because the savings are immediate and tangible.\n\nWould this be something your chapter would be interested in?"`,
      },
      {
        id: "part-5", label: "Join your local Chamber of Commerce and become a payment expert resource",
        cost: "$200–$500/year", impact: "medium", speed: "months",
        detail: "Chamber members refer each other constantly. Sponsor the monthly coffee meeting ($50–100). Offer a free statement review as a member benefit. Speak at one event per quarter.",
      },
      {
        id: "part-6", label: "Build relationships with business lenders and factoring companies",
        cost: "Free", impact: "medium", speed: "months",
        detail: "Business lenders talk to merchants who are growing and need better cash flow. Better payment processing = better cash flow. Natural partnership.",
        template: `Lender partnership pitch:\n\n"Hi [Name],\n\nI noticed you work with small businesses on financing. I run a merchant services company and I think there's a natural fit.\n\nWhen a business is looking at financing, their payment processing costs are often an overlooked cash flow lever — we frequently find merchants can recover $300–$800/month just by switching processors.\n\nWould you be open to referring clients for a free analysis? No pressure on your end — just a value-add for your clients. We pay $200 per successful referral."`,
      },
    ],
  },

  // ── COMMUNITY ─────────────────────────────────────────────────────────────────
  {
    id: "community",
    title: "Community & Networking",
    icon: Users,
    color: "border-orange-500",
    description: "In-person and community relationships close at 3–5x the rate of cold digital outreach. These channels are slow to start but produce high-quality, pre-sold leads.",
    weeklyTarget: "+10–50 signups/week",
    tasks: [
      {
        id: "com-1", label: "Join BNI (Business Network International) chapter",
        cost: "$500–700/year", impact: "high", speed: "months",
        detail: "BNI is a structured referral network. One member per industry per chapter. As the payment processing member, every other member refers their clients to you. Average BNI member gives and receives 20–40 referrals/year. ROI is almost always positive within 6 months.",
        link: "https://www.bni.com/find-a-chapter", linkLabel: "Find a BNI Chapter",
      },
      {
        id: "com-2", label: "Speak at one industry event or business association per month",
        cost: "Free (usually)", impact: "high", speed: "months",
        detail: "Offer to speak at restaurant association meetings, dental study clubs, retail associations. A 20-minute talk on 'Understanding Your Payment Processing Costs' positions you as the go-to expert.",
        template: `Talk abstract for event organizers:\n\n"Understanding Your Merchant Statement: How to Find Hidden Fees and Negotiate Better Rates"\n\n20-minute presentation covering:\n• How payment processing fees actually work (plain English)\n• How to read your merchant statement in 5 minutes\n• What's negotiable and what isn't\n• Industry-average rates by business type\n• 3 questions to ask your processor right now\n\nAttendees leave with a practical checklist and the ability to evaluate their own statement.\n\n[Speaker name] has reviewed 3,200+ merchant statements and helped businesses recover an average of $640/month in unnecessary fees.`,
      },
      {
        id: "com-3", label: "Attend 2 local networking events per week and give the 'free analysis' pitch",
        cost: "Free–$20/event", impact: "medium", speed: "immediate",
        detail: "The pitch at any networking event: 'I run a payment processing company. We do a free statement review for any business that accepts credit cards — we'll tell you exactly what you're paying and what you should be paying. Takes 24 hours, no obligation. Want the link?' This is your best in-person pitch — simple, valuable, no pressure.",
        template: `30-second elevator pitch:\n\n"I run Liberty Bancard. We help small businesses figure out if they're overpaying on their payment processing fees — which most of them are.\n\nWe do a free analysis — you send us your merchant statement, we send you back a breakdown in 24 hours showing exactly what you're paying versus what you should be paying.\n\nNo pitch, no obligation. Just numbers.\n\nDo you accept credit cards at your business? [Yes] — here's the link. [pulls up phone] Takes 2 minutes to upload."`,
      },
      {
        id: "com-4", label: "Create a 'Founding Merchant' exclusive program",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Offer the first 100 merchants who join a 'Founding Merchant' status with locked-in rates, dedicated rep, and lifetime referral bonuses. Creates urgency, exclusivity, and word of mouth. Market this on LinkedIn and in communities.",
        template: `Founding Merchant announcement:\n\n"We're opening 100 Founding Merchant spots at Liberty Bancard.\n\nWhat you get:\n• Locked-in interchange-plus pricing — your rate never increases\n• Dedicated account manager (direct cell, not a queue)\n• $150 referral bonus (instead of $100) for life\n• Early access to new products and hardware\n\nWhat we ask:\n• One honest Google review after 30 days\n• One referral introduction (not a sale — just an introduction) in your first 90 days\n\nWe're at [N] of 100 spots.\n\n[Application link]"`,
      },
    ],
  },

  // ── REVIEW ENGINE ─────────────────────────────────────────────────────────────
  {
    id: "reviews",
    title: "Review Generation Engine",
    icon: Star,
    color: "border-amber-500",
    description: "Reviews drive organic signups two ways: they improve your Google ranking (more impressions) and they convert skeptical leads (social proof). Every review is a permanent asset.",
    weeklyTarget: "+10–30 signups/week from trust signal lift",
    tasks: [
      {
        id: "rev-1", label: "Set up automated Google review request in GHL (30 days after merchant goes live)",
        cost: "Free", impact: "high", speed: "weeks",
        detail: "The best time to ask for a review is 30 days after a merchant goes live — they've seen their first lower statement and they're happy. Automate this in GHL: trigger = LB-LIVE tag + 30 day wait → send review request SMS + email.",
        template: `Review request SMS (Day 30 after go-live):\n"Hi [Name], it's been 30 days since you switched to Liberty Bancard. Hopefully you've seen the savings on your statement! If we've earned it, an honest Google review means the world to us and helps other business owners find us: [Google Review Link]. Takes 60 seconds. Thank you! — [Rep Name]"\n\nReview request email (same day):\nSubject: How are things going? (Quick ask)\n\nHi [Name],\n\nIt's been about a month since you switched to Liberty Bancard. I wanted to check in and see how things are going — any questions, issues, or anything we can improve?\n\nIf everything's been smooth, I have one small ask: an honest Google review. It helps other business owners find us and takes about 60 seconds.\n\n[Google Review Link]\n\nEither way, thank you for trusting us with your business.\n\n— [Name]`,
      },
      {
        id: "rev-2", label: "Personally reach out to your 10 happiest merchants for reviews today",
        cost: "Free", impact: "high", speed: "immediate",
        detail: "Don't wait for automation. Text or call your 10 best merchants personally. Personal asks convert at 50–70%. Automated asks convert at 10–15%.",
        template: `Personal text to happy merchant:\n"Hey [Name]! Hope business is going well. Quick favor — would you be willing to leave us a Google review? It literally takes 60 seconds and helps us help more businesses like yours. Here's the link: [link]. Thank you so much!"`,
      },
      {
        id: "rev-3", label: "Get listed on Trustpilot and actively collect reviews there",
        cost: "Free", impact: "medium", speed: "weeks",
        detail: "Trustpilot reviews show up in Google search results for branded searches. '100 reviews, 4.8 stars' in search results increases click-through rate 20–40%.",
        link: "https://business.trustpilot.com", linkLabel: "Create Trustpilot Business Account",
      },
      {
        id: "rev-4", label: "Respond to every Google review (positive and negative) within 24 hours",
        cost: "Free", impact: "medium", speed: "immediate",
        detail: "Responding to reviews increases your Google ranking and shows prospects you're responsive. For negative reviews: always acknowledge, never argue, offer to resolve offline.",
        template: `Positive review response:\n"Thank you so much, [Name]! It means a lot to hear this. Helping businesses like yours find savings they didn't know existed is exactly why we do what we do. Please don't hesitate to reach out anytime."\n\nNegative review response:\n"Thank you for the feedback, [Name]. I'm sorry your experience wasn't what you expected — that's not the standard we hold ourselves to. I'd like to understand what happened and make it right. Please call me directly at [phone] or email [email] and I'll personally handle it."`,
      },
    ],
  },

  // ── PLATFORM BUILDS ───────────────────────────────────────────────────────────
  {
    id: "builds",
    title: "Platform Features to Build (Growth Unlocks)",
    icon: Rocket,
    color: "border-indigo-500",
    description: "These are features to build inside this platform that directly accelerate organic growth. Each one creates a viral or referral loop that compounds over time.",
    weeklyTarget: "Unlocks 100–300 additional signups/week",
    tasks: [
      {
        id: "build-1", label: "Build 'Share My Savings' viral page — post-analysis shareable result",
        cost: "Dev time", impact: "high", speed: "weeks",
        detail: "After a merchant analysis is completed, generate a branded results card at a unique URL: 'Liberty Bancard found I was overpaying by $782/month.' With social share buttons for LinkedIn, Facebook, and Twitter. This is a free viral loop — every satisfied merchant becomes a distributor.",
      },
      {
        id: "build-2", label: "Build embeddable savings calculator widget for partner websites",
        cost: "Dev time", impact: "high", speed: "weeks",
        detail: "A small JavaScript embed that CPAs, bookkeepers, and partners can put on their own websites. Widget shows 'Estimate Your Processing Savings' — inputs volume and current rate, shows estimated savings, links to /upload-statement with partner referral code pre-baked. Every embed is a permanent lead source.",
      },
      {
        id: "build-3", label: "Build /partners/cpa and /partners/bookkeeper landing pages",
        cost: "Dev time", impact: "high", speed: "weeks",
        detail: "Dedicated landing pages for CPA and bookkeeper partners that speak their language: 'Your clients are asking about processing fees. Here's how to help them — and earn a residual income doing it.' Include: how the program works, commission structure, testimonials from other financial professionals, simple application.",
      },
      {
        id: "build-4", label: "Build a 'Founding Merchant' application page",
        cost: "Dev time", impact: "medium", speed: "weeks",
        detail: "A dedicated /founding-merchant page with a countdown (100 spots, [N] remaining). Application form. Auto-sends welcome email via GHL. Creates urgency and exclusivity without paid ads.",
      },
      {
        id: "build-5", label: "Add 'Refer a Friend' button to merchant portal and post-analysis page",
        cost: "Dev time", impact: "high", speed: "weeks",
        detail: "Surface the referral program at the highest-satisfaction moments: (1) right after analysis results are shown, (2) inside the merchant portal dashboard. 'Know a business owner who'd benefit from this? Send them your referral link: [link]. You earn $100 when they sign up.'",
      },
      {
        id: "build-6", label: "Build Google review automation into GHL sequence (30-day post-live trigger)",
        cost: "GHL config only", impact: "high", speed: "weeks",
        detail: "In GHL: when tag LB-LIVE is applied → wait 30 days → send review request SMS + email (templates in Reviews tab). This is pure automation — set it up once, runs forever.",
      },
      {
        id: "build-7", label: "Add newsletter signup with 'Statement Decoder PDF' offer to all blog posts",
        cost: "Dev time", impact: "medium", speed: "weeks",
        detail: "Add an inline signup form to every blog post: 'Download The Merchant Statement Decoder — free PDF guide.' Captures email → enters GHL sequence → receives PDF → enters nurture sequence. Converts blog readers into leads.",
      },
      {
        id: "build-8", label: "Build a referral leaderboard for affiliates",
        cost: "Dev time", impact: "medium", speed: "weeks",
        detail: "Show top referrers in the affiliate dashboard. Even anonymous ('Referrer #1 — 47 referrals this month'). Gamification increases referral activity 20–40%. Add monthly prizes for top referrers.",
      },
    ],
  },

  // ── WEEKLY TRACKER ───────────────────────────────────────────────────────────
  {
    id: "tracker",
    title: "Weekly Activity Tracker",
    icon: Target,
    color: "border-teal-500",
    description: "The habits that compound. Do these every week without fail. Consistency beats intensity.",
    weeklyTarget: "The base cadence for all channels",
    tasks: [
      { id: "tr-1", label: "Post 3× on LinkedIn (Mon/Wed/Fri)", cost: "Free", impact: "high", speed: "immediate", detail: "Statement teardown, myth bust, or case study. Real numbers. No fluff." },
      { id: "tr-2", label: "Answer 5–10 Reddit/Quora questions", cost: "Free", impact: "medium", speed: "immediate", detail: "30 minutes daily in r/smallbusiness, r/entrepreneur, and vertical subreddits." },
      { id: "tr-3", label: "Publish 1 YouTube video", cost: "Free", impact: "high", speed: "weeks", detail: "Record, edit in CapCut, publish. Clip 2–3 short-form versions for TikTok and Reels." },
      { id: "tr-4", label: "Publish 2 blog posts targeting keyword research list", cost: "Free", impact: "high", speed: "months", detail: "Work through the priority blog post list from Phase 2 in order." },
      { id: "tr-5", label: "Send 20 LinkedIn connection requests to CPAs and bookkeepers", cost: "Free", impact: "high", speed: "months", detail: "Search: 'CPA [state]', 'QuickBooks ProAdvisor', 'bookkeeper small business'. Connect + follow up in 3 days." },
      { id: "tr-6", label: "Respond to 3 HARO queries", cost: "Free", impact: "high", speed: "weeks", detail: "Check HARO emails (morning, midday, evening sends). Respond same-day — journalists pick quickly." },
      { id: "tr-7", label: "Post on GBP (Google Business Profile)", cost: "Free", impact: "medium", speed: "immediate", detail: "Repurpose your LinkedIn post as a GBP post. 5 minutes. Improves local search ranking." },
      { id: "tr-8", label: "Request 1 review from a happy merchant", cost: "Free", impact: "high", speed: "immediate", detail: "Personal text or call. Don't rely on automation alone for reviews." },
      { id: "tr-9", label: "Send the weekly newsletter to email list", cost: "Free", impact: "medium", speed: "weeks", detail: "One insight, one case study, one CTA. Under 400 words. Consistent cadence builds trust." },
      { id: "tr-10", label: "Follow up with 10 partner prospects (CPAs/bookkeepers) in pipeline", cost: "Free", impact: "high", speed: "months", detail: "Track partner outreach in a simple spreadsheet: Name, Company, Date contacted, Status, Next action." },
      { id: "tr-11", label: "Check and respond to all reviews (Google, Trustpilot, BBB)", cost: "Free", impact: "medium", speed: "immediate", detail: "Every review responded to within 24 hours. Set a Google alert for your brand name." },
      { id: "tr-12", label: "Attend 1 local networking event", cost: "Free–$20", impact: "medium", speed: "immediate", detail: "Chamber, BNI visitors day, industry association, Rotary. Always have the 30-second pitch ready." },
    ],
  },
];

// ─── Timeline table ───────────────────────────────────────────────────────────

const TIMELINE = [
  { milestone: "50 signups/week", when: "Week 2–3", drivers: "GBP claimed + referral activation + LinkedIn started" },
  { milestone: "100 signups/week", when: "Week 4–6", drivers: "Partner outreach + Reddit + Facebook groups + CRO improvements live" },
  { milestone: "250 signups/week", when: "Week 8–12", drivers: "Blog posts starting to rank + YouTube channel + 10–20 active partners" },
  { milestone: "500 signups/week", when: "Month 4–5", drivers: "SEO compounding + partner referrals + review engine running + video SEO" },
  { milestone: "1,000 signups/week", when: "Month 5–7", drivers: "All channels firing + viral share features + partner network at 50+ + YouTube ranking" },
];

// ─────────────────────────────────────────────────────────────────────────────
// TAB: TOOLS
// ─────────────────────────────────────────────────────────────────────────────

interface ToolCard {
  name: string;
  description: string;
  href: string;
  external?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

const INTERNAL_TOOLS: ToolCard[] = [
  { name: "Content Editor", description: "Write, draft with AI, schedule, and publish blog posts that rank for high-value keywords.", href: "/dashboard/content", icon: FileText, badge: "Blog" },
  { name: "SEO Health", description: "Monitor keyword rankings, crawl issues, and on-page optimization scores across all public pages.", href: "/dashboard/seo-health", icon: Search, badge: "SEO" },
  { name: "Reporting & Analytics", description: "Lead source performance, conversion funnels, and revenue attribution across all growth channels.", href: "/dashboard/reporting", icon: BarChart2, badge: "Analytics" },
  { name: "Affiliate Dashboard", description: "Track affiliate signups, referral codes, commission payouts, and top performers.", href: "/dashboard/affiliates", icon: Gift, badge: "Referrals" },
  { name: "GHL Workflows", description: "Record reference GHL workflow IDs per sequence name. Replit owns cadence; IDs are not required to launch.", href: "/dashboard/integrations", icon: Zap, badge: "GHL" },
  { name: "Sequences", description: "Build and manage multi-step outreach sequences for cold, warm, and nurture leads.", href: "/dashboard/sequences", icon: Mail, badge: "Outreach" },
  { name: "Contacts", description: "Full contact list with enrichment status, pipeline stage, tags, and last activity.", href: "/dashboard/contacts", icon: Users, badge: "CRM" },
  { name: "Partner Portal", description: "View partner accounts, referred merchant lists, commission tiers, and co-branded assets.", href: "/partners/portal", icon: Handshake, badge: "Partners" },
  { name: "GHL Sequence Guide", description: "Step-by-step reference for building all 6 GHL sequences: inbound, cold, reply, statement, proposal, and nurture.", href: "/dashboard/ghl-sequence-guide", icon: BookOpen, badge: "Reference" },
  { name: "Outreach Command Center", description: "Manage AI SDR pipeline: entity imports, enrichment, processor detection, and tech stack intelligence.", href: "/dashboard/outreach", icon: Megaphone, badge: "SDR" },
  { name: "Retention Campaigns", description: "Launch targeted retention sequences for at-risk merchants based on NPS and health scores.", href: "/dashboard/retention-campaigns", icon: Target, badge: "Retention" },
  { name: "Operator Dashboard", description: "Real-time KPIs, send monitoring, webhook event logs, stuck lead alerts, and anomaly detection.", href: "/dashboard/operator", icon: BarChart3, badge: "Ops" },
];

const EXTERNAL_TOOLS: ToolCard[] = [
  { name: "Hotjar", description: "Free heatmaps and session recordings. Install on /upload-statement, /free-analysis, and homepage. Review after 500 sessions.", href: "https://www.hotjar.com", external: true, icon: BarChart2, badge: "CRO" },
  { name: "Google Business Profile", description: "Claim and optimize your GBP listing. 'Merchant services near me' converts at 15–25%. Most important free lead channel.", href: "https://business.google.com", external: true, icon: Globe, badge: "Local SEO" },
  { name: "Trustpilot (Free)", description: "Set up your free business profile to collect and display reviews. Sync review requests via GHL.", href: "https://business.trustpilot.com", external: true, icon: Star, badge: "Reviews" },
  { name: "HARO / Connectively", description: "Get quoted in journalist stories as a payment processing expert. Sends 3 emails/day with query opportunities.", href: "https://www.connectively.us", external: true, icon: Mic, badge: "PR" },
  { name: "Canva (Free)", description: "Create LinkedIn graphics, YouTube thumbnails, one-pagers, and social proof assets without a designer.", href: "https://www.canva.com", external: true, icon: PenLine, badge: "Design" },
];

function ToolsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2"><Wrench className="h-4 w-4 text-primary" /> Platform Tools</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Every internal tool that supports growth execution — direct links, no hunting.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {INTERNAL_TOOLS.map(tool => {
          const Icon = tool.icon;
          return (
            <Link key={tool.name} href={tool.href}>
              <div className="border rounded-lg p-4 hover:bg-muted/40 hover:border-primary/40 transition-colors cursor-pointer h-full flex flex-col gap-2" data-testid={`tool-card-${tool.name.toLowerCase().replace(/\s+/g, '-')}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-primary shrink-0" />
                    <span className="font-semibold text-sm">{tool.name}</span>
                  </div>
                  {tool.badge && <Badge variant="secondary" className="text-[10px]">{tool.badge}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed flex-1">{tool.description}</p>
                <div className="flex items-center gap-1 text-xs text-primary font-medium">
                  Open <ArrowRight className="h-3 w-3" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      <div>
        <h2 className="text-base font-semibold flex items-center gap-2"><ExternalLink className="h-4 w-4 text-orange-500" /> External Tools</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Free third-party tools that directly support execution of this playbook.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {EXTERNAL_TOOLS.map(tool => {
          const Icon = tool.icon;
          return (
            <a key={tool.name} href={tool.href} target="_blank" rel="noopener noreferrer">
              <div className="border rounded-lg p-4 hover:bg-muted/40 hover:border-orange-400/40 transition-colors cursor-pointer h-full flex flex-col gap-2" data-testid={`tool-card-ext-${tool.name.toLowerCase().replace(/\s+/g, '-')}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-orange-500 shrink-0" />
                    <span className="font-semibold text-sm">{tool.name}</span>
                  </div>
                  {tool.badge && <Badge variant="outline" className="text-[10px]">{tool.badge}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed flex-1">{tool.description}</p>
                <div className="flex items-center gap-1 text-xs text-orange-500 font-medium">
                  Open in new tab <ExternalLink className="h-3 w-3" />
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: PARTNER PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

type PartnerStatus = "Not Contacted" | "Sent" | "Connected" | "Call Booked" | "Active Partner" | "Passed";
type PartnerType = "CPA" | "Bookkeeper" | "Insurance" | "Lender" | "Other";

interface PartnerRow {
  id: string;
  name: string;
  company: string;
  type: PartnerType;
  dateContacted: string;
  status: PartnerStatus;
  notes: string;
  nextAction: string;
}

const PARTNER_STATUSES: PartnerStatus[] = ["Not Contacted", "Sent", "Connected", "Call Booked", "Active Partner", "Passed"];
const PARTNER_TYPES: PartnerType[] = ["CPA", "Bookkeeper", "Insurance", "Lender", "Other"];

const STATUS_COLORS: Record<PartnerStatus, string> = {
  "Not Contacted": "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  "Sent": "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  "Connected": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  "Call Booked": "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  "Active Partner": "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  "Passed": "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
};

const LS_PARTNERS = "gp_partner_pipeline_v1";

function generateId() { return Math.random().toString(36).slice(2, 10); }

function PartnerPipelineTab() {
  const { toast } = useToast();
  const [rows, setRows] = useState<PartnerRow[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_PARTNERS) || "[]"); } catch { return []; }
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<PartnerRow>>({});
  const [adding, setAdding] = useState(false);

  useEffect(() => { localStorage.setItem(LS_PARTNERS, JSON.stringify(rows)); }, [rows]);

  const summary = useMemo(() => ({
    active: rows.filter(r => r.status === "Active Partner").length,
    pipeline: rows.filter(r => !["Not Contacted", "Active Partner", "Passed"].includes(r.status)).length,
    notContacted: rows.filter(r => r.status === "Not Contacted").length,
  }), [rows]);

  function startAdd() {
    setDraft({ status: "Not Contacted", type: "CPA", dateContacted: new Date().toISOString().slice(0, 10) });
    setAdding(true);
    setEditing(null);
  }

  function saveAdd() {
    if (!draft.name?.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    const row: PartnerRow = {
      id: generateId(), name: draft.name || "", company: draft.company || "",
      type: (draft.type as PartnerType) || "CPA", dateContacted: draft.dateContacted || "",
      status: (draft.status as PartnerStatus) || "Not Contacted",
      notes: draft.notes || "", nextAction: draft.nextAction || "",
    };
    setRows(prev => [row, ...prev]);
    setAdding(false);
    setDraft({});
    toast({ title: "Partner added" });
  }

  function startEdit(row: PartnerRow) { setEditing(row.id); setDraft({ ...row }); setAdding(false); }

  function saveEdit() {
    setRows(prev => prev.map(r => r.id === editing ? { ...r, ...draft } as PartnerRow : r));
    setEditing(null); setDraft({});
    toast({ title: "Partner updated" });
  }

  function deleteRow(id: string) {
    setRows(prev => prev.filter(r => r.id !== id));
    if (editing === id) { setEditing(null); setDraft({}); }
  }

  function exportCSV() {
    const header = ["Name", "Company", "Type", "Date Contacted", "Status", "Notes", "Next Action"];
    const lines = rows.map(r => [r.name, r.company, r.type, r.dateContacted, r.status, r.notes, r.nextAction].map(v => `"${(v || "").replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "partner-pipeline.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  const EditableRow = ({ row }: { row: PartnerRow }) => {
    const isEditing = editing === row.id;
    if (isEditing) {
      return (
        <tr className="bg-muted/30">
          {["name", "company"].map(f => (
            <td key={f} className="px-2 py-1.5">
              <Input className="h-7 text-xs" value={(draft as any)[f] || ""} onChange={e => setDraft(p => ({ ...p, [f]: e.target.value }))} data-testid={`input-partner-${f}`} />
            </td>
          ))}
          <td className="px-2 py-1.5">
            <Select value={draft.type || "CPA"} onValueChange={v => setDraft(p => ({ ...p, type: v as PartnerType }))}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{PARTNER_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </td>
          <td className="px-2 py-1.5">
            <Input type="date" className="h-7 text-xs" value={draft.dateContacted || ""} onChange={e => setDraft(p => ({ ...p, dateContacted: e.target.value }))} data-testid="input-partner-date" />
          </td>
          <td className="px-2 py-1.5">
            <Select value={draft.status || "Not Contacted"} onValueChange={v => setDraft(p => ({ ...p, status: v as PartnerStatus }))}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{PARTNER_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </td>
          <td className="px-2 py-1.5">
            <Input className="h-7 text-xs" value={draft.notes || ""} onChange={e => setDraft(p => ({ ...p, notes: e.target.value }))} placeholder="Notes" data-testid="input-partner-notes" />
          </td>
          <td className="px-2 py-1.5">
            <Input className="h-7 text-xs" value={draft.nextAction || ""} onChange={e => setDraft(p => ({ ...p, nextAction: e.target.value }))} placeholder="Next action" data-testid="input-partner-next" />
          </td>
          <td className="px-2 py-1.5">
            <div className="flex gap-1">
              <Button size="sm" className="h-7 text-xs px-2" onClick={saveEdit} data-testid="button-partner-save">Save</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => { setEditing(null); setDraft({}); }}>Cancel</Button>
            </div>
          </td>
        </tr>
      );
    }
    return (
      <tr className="border-b hover:bg-muted/20 last:border-0" data-testid={`row-partner-${row.id}`}>
        <td className="px-2 py-2 text-xs font-medium">{row.name}</td>
        <td className="px-2 py-2 text-xs text-muted-foreground">{row.company}</td>
        <td className="px-2 py-2"><Badge variant="outline" className="text-[10px]">{row.type}</Badge></td>
        <td className="px-2 py-2 text-xs text-muted-foreground">{row.dateContacted}</td>
        <td className="px-2 py-2"><Badge className={`text-[10px] ${STATUS_COLORS[row.status]}`}>{row.status}</Badge></td>
        <td className="px-2 py-2 text-xs text-muted-foreground max-w-[140px] truncate" title={row.notes}>{row.notes}</td>
        <td className="px-2 py-2 text-xs text-muted-foreground max-w-[120px] truncate" title={row.nextAction}>{row.nextAction}</td>
        <td className="px-2 py-2">
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => startEdit(row)} aria-label="Edit partner" data-testid={`button-partner-edit-${row.id}`}><PenLine className="h-3 w-3" /></Button>
            <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => deleteRow(row.id)} aria-label="Delete partner" data-testid={`button-partner-delete-${row.id}`}><Trash2 className="h-3 w-3" /></Button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2"><Handshake className="h-4 w-4 text-primary" /> Partner Outreach Pipeline</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Track every CPA, bookkeeper, insurance, and lender partner prospect. Data saves in your browser.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={exportCSV} className="gap-1.5 text-xs" data-testid="button-partner-export"><Download className="h-3.5 w-3.5" /> Export CSV</Button>
          <Button size="sm" onClick={startAdd} className="gap-1.5 text-xs" data-testid="button-partner-add"><PlusCircle className="h-3.5 w-3.5" /> Add Partner</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: "Active Partners", value: summary.active, color: "text-green-600 dark:text-green-400" },
          { label: "In Pipeline", value: summary.pipeline, color: "text-blue-600 dark:text-blue-400" },
          { label: "Not Contacted", value: summary.notContacted, color: "text-muted-foreground" },
        ].map(stat => (
          <Card key={stat.label}><CardContent className="pt-4 pb-3 text-center">
            <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
            <div className="text-xs text-muted-foreground">{stat.label}</div>
          </CardContent></Card>
        ))}
      </div>

      <Card>
        <CardContent className="pt-4 overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b">
                {["Partner Name", "Company", "Type", "Date Contacted", "Status", "Notes", "Next Action", ""].map(h => (
                  <th key={h} className="text-left px-2 py-2 font-semibold text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {adding && (
                <tr className="bg-muted/30 border-b">
                  {["name", "company"].map(f => (
                    <td key={f} className="px-2 py-1.5">
                      <Input className="h-7 text-xs" placeholder={f === "name" ? "Partner name*" : "Company"} value={(draft as any)[f] || ""} onChange={e => setDraft(p => ({ ...p, [f]: e.target.value }))} data-testid={`input-new-partner-${f}`} />
                    </td>
                  ))}
                  <td className="px-2 py-1.5">
                    <Select value={draft.type || "CPA"} onValueChange={v => setDraft(p => ({ ...p, type: v as PartnerType }))}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{PARTNER_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="date" className="h-7 text-xs" value={draft.dateContacted || ""} onChange={e => setDraft(p => ({ ...p, dateContacted: e.target.value }))} data-testid="input-new-partner-date" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Select value={draft.status || "Not Contacted"} onValueChange={v => setDraft(p => ({ ...p, status: v as PartnerStatus }))}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{PARTNER_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </td>
                  <td className="px-2 py-1.5"><Input className="h-7 text-xs" placeholder="Notes" value={draft.notes || ""} onChange={e => setDraft(p => ({ ...p, notes: e.target.value }))} /></td>
                  <td className="px-2 py-1.5"><Input className="h-7 text-xs" placeholder="Next action" value={draft.nextAction || ""} onChange={e => setDraft(p => ({ ...p, nextAction: e.target.value }))} /></td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1">
                      <Button size="sm" className="h-7 text-xs px-2" onClick={saveAdd} data-testid="button-new-partner-save">Add</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => { setAdding(false); setDraft({}); }}>Cancel</Button>
                    </div>
                  </td>
                </tr>
              )}
              {rows.length === 0 && !adding ? (
                <tr><td colSpan={8} className="px-2 py-8 text-center text-muted-foreground text-xs">No partners yet. Click "Add Partner" to start tracking your outreach pipeline.</td></tr>
              ) : (
                rows.map(row => <EditableRow key={row.id} row={row} />)
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: CONTENT REPURPOSING
// ─────────────────────────────────────────────────────────────────────────────

const LS_REPURPOSE_WEEK = "gp_repurpose_week_v1";

interface ContentOutput {
  id: string;
  label: string;
  format: string;
  template: string;
}

const CONTENT_OUTPUTS: ContentOutput[] = [
  {
    id: "linkedin", label: "LinkedIn Post", format: "300–500 words",
    template: `📊 Statement Teardown — [MERCHANT TYPE]

I reviewed a [MERCHANT TYPE]'s merchant statement today.

Here's what I found:
• Total processing volume: $[VOLUME]
• Interchange (base cost): $[INTERCHANGE]
• Processor markup: $[MARKUP] ← This is the problem
• Effective rate: [RATE]%
• What they should be paying: [TARGET_RATE]%

That's $[MONTHLY_SAVINGS]/month in unnecessary fees.
$[ANNUAL_SAVINGS]/year.

And they had no idea.

If you accept credit cards and haven't reviewed your statement in the last 12 months — when was the last time you looked at what your processor is actually making off you?

[Upload link in first comment]`,
  },
  {
    id: "blog", label: "Blog Post", format: "1,500–2,500 words",
    template: `Title: How We Helped a [MERCHANT TYPE] Save $[MONTHLY_SAVINGS]/Month on Payment Processing

Introduction:
When [MERCHANT_NAME] came to us, they were paying [OLD_RATE]% on $[VOLUME]/month in credit card volume. They assumed their rates were "standard" — their processor had told them so.

They were wrong.

[SECTION 1: What we found on the statement]
The first thing we look at is the effective rate — total fees divided by total volume. [MERCHANT_NAME]'s was [OLD_RATE]%. For a [MERCHANT TYPE], industry average is [INDUSTRY_AVG]%.

[SECTION 2: Breaking down where the money went]
Interchange: $[INTERCHANGE] (this is fixed — set by Visa/Mastercard)
Processor markup: $[MARKUP] ← 100% negotiable

[SECTION 3: What changed]
We moved them to interchange-plus pricing...

[SECTION 4: Results]
New effective rate: [NEW_RATE]%
Monthly savings: $[MONTHLY_SAVINGS]
Annual savings: $[ANNUAL_SAVINGS]

[CTA]
Want to see what you're actually paying? Upload your statement for a free 24-hour analysis → [LINK]`,
  },
  {
    id: "youtube", label: "YouTube Video Script", format: "5–10 min video",
    template: `TITLE: I Reviewed a [MERCHANT TYPE]'s Merchant Statement — Here's What I Found

HOOK (0:00–0:20):
"This [MERCHANT TYPE] was paying $[MONTHLY_SAVINGS] more per month than they needed to. They had no idea. Today I'm going to show you exactly what I found and how we fixed it."

INTRO (0:20–1:00):
"Hey everyone — [NAME] from Liberty Bancard. We do free merchant statement reviews, and today I'm walking through a real example — I've anonymized the details. Let's get into it."

[SCREEN SHARE: Statement PDF]

BREAKDOWN (1:00–5:00):
• Show the statement header
• Circle the total fees line
• Calculate the effective rate live: [TOTAL_FEES] / [VOLUME] = [RATE]%
• Compare to industry benchmark
• Highlight the markup section

WHAT WE DID (5:00–7:00):
• Moved to interchange-plus pricing
• Renegotiated the per-transaction fee
• Removed the monthly "service fee"

RESULTS (7:00–8:30):
• Before: $[OLD_MONTHLY_FEES]/month
• After: $[NEW_MONTHLY_FEES]/month
• Savings: $[MONTHLY_SAVINGS]/month

OUTRO / CTA (8:30–9:00):
"If you want to see what you're paying, drop your statement at the link below. It's free, takes 2 minutes, and we'll have your analysis back within 24 hours. See you in the next one."`,
  },
  {
    id: "short1", label: "Short-Form Clip #1 (Hook)", format: "30–60 sec",
    template: `HOOK CLIP — "The Number on Your Statement Nobody Talks About"

[Open on statement screenshot or talking head]

"There's a number on your merchant statement that your processor hopes you never look at.

It's called the processor markup — and it's the difference between what Visa charges and what you actually pay.

For this [MERCHANT TYPE], that number was [MARKUP_PCT]%.

On $[VOLUME]/month, that's $[MARKUP_DOLLARS].

Every. Single. Month.

We got them to [NEW_MARKUP_PCT]% — saving them $[MONTHLY_SAVINGS]/month.

Link in bio to get your statement reviewed free."

[END CARD with link]`,
  },
  {
    id: "short2", label: "Short-Form Clip #2 (Results)", format: "30–60 sec",
    template: `RESULTS CLIP — "Before and After"

[Split screen or text animation]

"Before Liberty Bancard: $[OLD_MONTHLY_FEES]/month
After Liberty Bancard: $[NEW_MONTHLY_FEES]/month

That's $[MONTHLY_SAVINGS] back in their pocket. Every month. Forever.

[MERCHANT TYPE]. $[VOLUME]/month in volume.

They switched in [SWITCH_TIME] days.

Free analysis at [LINK]. Takes 2 minutes."`,
  },
  {
    id: "short3", label: "Short-Form Clip #3 (Education)", format: "30–60 sec",
    template: `EDUCATION CLIP — "What Is Your Effective Rate?"

"Most merchants have no idea what their effective rate is. Here's how to calculate it in 10 seconds.

Take your total processing fees for the month. Divide by your total processing volume.

Example: $2,400 in fees ÷ $85,000 in volume = 2.82% effective rate.

Here's what it should be for your industry:
• Restaurant: 2.2–2.5%
• Retail: 1.9–2.4%
• Medical: 2.0–2.6%

If you're above those numbers, you're overpaying.

Upload your statement at [LINK] — we'll tell you in plain English exactly where you stand."`,
  },
  {
    id: "reddit", label: "Reddit Answer", format: "200–400 words",
    template: `[In response to: "Are my credit card processing fees too high?"]

Hard to say without seeing the statement, but here's how to check yourself in about 30 seconds:

Take your total processing fees for the month and divide by your total volume. That's your effective rate.

Example: $2,100 in fees ÷ $78,000 in volume = 2.69%

Industry benchmarks:
• Restaurant: 2.2–2.8%
• Retail: 1.9–2.5%  
• Medical: 2.0–2.6%
• E-commerce: 2.5–3.2%

If you're above those numbers, there's room to improve.

The key thing to look at is your "processor markup" — it's the line on your statement that shows what your processor is charging on top of interchange (the base rate set by Visa/Mastercard). The markup is 100% negotiable. The interchange is not.

For context, I reviewed a [MERCHANT TYPE] recently paying [OLD_RATE]% effective rate. We got them to [NEW_RATE]%. That's $[MONTHLY_SAVINGS]/month they're now keeping.

Happy to look at your statement if you want a real breakdown — link in my profile. No cost, no obligation, results in 24 hours.`,
  },
  {
    id: "newsletter", label: "Newsletter Section", format: "150–250 words",
    template: `📊 CASE STUDY OF THE WEEK

This week we reviewed a [MERCHANT TYPE] processing $[VOLUME]/month.

What we found:
Their effective rate was [OLD_RATE]% — about [DELTA_PCT]% above industry average for their category.

The culprit: a "non-qualified surcharge" of [NQ_RATE]% applied to most of their card volume, plus a monthly "service fee" of $[SERVICE_FEE] that wasn't providing any visible value.

What we did:
→ Moved them to interchange-plus pricing
→ Eliminated the NQ surcharge
→ Renegotiated the per-transaction fee from $[OLD_PER_TRANS] to $[NEW_PER_TRANS]

The result:
New effective rate: [NEW_RATE]%
Monthly savings: $[MONTHLY_SAVINGS]
Annual savings: $[ANNUAL_SAVINGS]

Time to switch: [SWITCH_TIME] business days.

If you haven't had your statement reviewed in the last 12 months, upload it here for a free analysis → [LINK]`,
  },
];

function ContentRepurposingTab() {
  const { toast } = useToast();
  const [completed, setCompleted] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_REPURPOSE_WEEK) || "{}");
      const weekKey = getWeekKey();
      return saved.week === weekKey ? saved.items : {};
    } catch { return {}; }
  });

  function getWeekKey() {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${week}`;
  }

  function toggle(id: string) {
    const next = { ...completed, [id]: !completed[id] };
    setCompleted(next);
    localStorage.setItem(LS_REPURPOSE_WEEK, JSON.stringify({ week: getWeekKey(), items: next }));
  }

  function resetAll() {
    setCompleted({});
    localStorage.setItem(LS_REPURPOSE_WEEK, JSON.stringify({ week: getWeekKey(), items: {} }));
    toast({ title: "Checklist reset for this week" });
  }

  const doneCount = Object.values(completed).filter(Boolean).length;
  const total = CONTENT_OUTPUTS.length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2"><Repeat2 className="h-4 w-4 text-primary" /> Content Repurposing Workflow</h2>
          <p className="text-xs text-muted-foreground mt-0.5">One merchant statement review → 8 content outputs. Work through this list each week.</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={doneCount === total ? "default" : "secondary"} className="text-xs">{doneCount}/{total} done this week</Badge>
          <Button size="sm" variant="outline" onClick={resetAll} className="gap-1.5 text-xs" data-testid="button-repurpose-reset"><RefreshCw className="h-3.5 w-3.5" /> Reset Week</Button>
        </div>
      </div>

      <div className="flex gap-3 p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
        <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <p className="text-xs text-blue-700 dark:text-blue-400">
          <strong>The workflow:</strong> Start with one real merchant statement review (anonymize the numbers). Use the real savings figure — e.g. "$640/month". Fill in the <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">[PLACEHOLDERS]</code> in each template, then tick it off as you create the asset.
        </p>
      </div>

      <Progress value={Math.round((doneCount / total) * 100)} className="h-2" />

      <div className="space-y-3">
        {CONTENT_OUTPUTS.map((output, i) => {
          const done = !!completed[output.id];
          return (
            <div key={output.id} className={`border rounded-lg overflow-hidden transition-colors ${done ? "opacity-70" : ""}`} data-testid={`repurpose-item-${output.id}`}>
              <div className="flex items-center gap-3 p-3 hover:bg-muted/20">
                <button
                  className={`h-5 w-5 rounded border flex items-center justify-center shrink-0 transition-colors ${done ? "bg-green-500 border-green-500" : "border-muted-foreground/40 hover:border-green-400"}`}
                  onClick={() => toggle(output.id)}
                  aria-label={`Mark ${output.label} as done`}
                  data-testid={`check-repurpose-${output.id}`}
                >
                  {done && <CheckCircle2 className="h-3.5 w-3.5 text-white" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-muted-foreground w-5">{i + 1}.</span>
                    <span className={`text-sm font-medium ${done ? "line-through text-muted-foreground" : ""}`}>{output.label}</span>
                    <Badge variant="outline" className="text-[10px]">{output.format}</Badge>
                  </div>
                </div>
              </div>
              <div className="border-t bg-muted/10 px-3 pb-3 pt-2">
                <CopyBlock text={output.template} label="Template — fill in [PLACEHOLDERS] then copy" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: WEEKLY REVIEW
// ─────────────────────────────────────────────────────────────────────────────

const LS_WEEKLY_REVIEW = "gp_weekly_review_v1";

const REVIEW_CHECKLIST = [
  { id: "pull-report", label: "Pull lead source report", link: "/dashboard/reporting", linkLabel: "Open Reporting" },
  { id: "channel-check", label: "Review which channels fired vs. missed this week" },
  { id: "signup-log", label: "Log this week's actual signups vs. target" },
  { id: "top-channel", label: "Pick next week's #1 focus channel" },
  { id: "follow-ups", label: "Assign any follow-up tasks in the CRM", link: "/dashboard/tasks", linkLabel: "Open Tasks" },
  { id: "partner-update", label: "Update at least 3 rows in the Partner Pipeline tab" },
  { id: "content-check", label: "Verify content repurposing checklist is on track" },
  { id: "review-request", label: "Send at least 1 personal review request to a happy merchant" },
  { id: "scorecard-update", label: "Fill in This Week Actual numbers in the Scorecard tab" },
];

interface WeekReview {
  weekKey: string;
  weekLabel: string;
  checklistDone: Record<string, boolean>;
  signupsActual: string;
  signupsTarget: string;
  focusChannel: string;
  notes: string;
  completedAt?: string;
}

function getWeekReviewKey() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

function getWeekLabel(key: string) {
  const [year, weekStr] = key.split("-W");
  const jan1 = new Date(Number(year), 0, 1);
  const dayOfYear = (Number(weekStr) - 1) * 7 - jan1.getDay() + 1;
  const start = new Date(Number(year), 0, dayOfYear);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function WeeklyReviewTab() {
  const { toast } = useToast();
  const weekKey = getWeekReviewKey();

  const [history, setHistory] = useState<WeekReview[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_WEEKLY_REVIEW) || "[]"); } catch { return []; }
  });

  const current: WeekReview = history.find(w => w.weekKey === weekKey) || {
    weekKey, weekLabel: getWeekLabel(weekKey),
    checklistDone: {}, signupsActual: "", signupsTarget: "", focusChannel: "", notes: "",
  };

  function updateCurrent(updates: Partial<WeekReview>) {
    const updated = { ...current, ...updates };
    const next = history.filter(w => w.weekKey !== weekKey);
    next.unshift(updated);
    setHistory(next);
    localStorage.setItem(LS_WEEKLY_REVIEW, JSON.stringify(next));
  }

  function toggleCheck(id: string) {
    updateCurrent({ checklistDone: { ...current.checklistDone, [id]: !current.checklistDone[id] } });
  }

  function completeReview() {
    updateCurrent({ completedAt: new Date().toISOString() });
    toast({ title: "Weekly review saved ✓", description: "Great work. See you next week!" });
  }

  const checkedCount = REVIEW_CHECKLIST.filter(i => current.checklistDone[i.id]).length;
  const pct = Math.round((checkedCount / REVIEW_CHECKLIST.length) * 100);
  const pastWeeks = history.filter(w => w.weekKey !== weekKey).slice(0, 4);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2"><ListChecks className="h-4 w-4 text-primary" /> Weekly Review — 15 Minutes</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Run this every Friday (or Monday morning). Consistency is the growth lever. Data saves in your browser.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><ClipboardCheck className="h-4 w-4" /> This Week — {current.weekLabel}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">Review checklist</span>
              <Badge variant={pct === 100 ? "default" : "secondary"} className="text-xs">{checkedCount}/{REVIEW_CHECKLIST.length}</Badge>
            </div>
            <Progress value={pct} className="h-1.5 mb-2" />
            <div className="space-y-1.5">
              {REVIEW_CHECKLIST.map(item => (
                <div key={item.id} className="flex items-center gap-2.5" data-testid={`review-item-${item.id}`}>
                  <button
                    className={`h-4.5 w-4.5 rounded border flex items-center justify-center shrink-0 transition-colors ${current.checklistDone[item.id] ? "bg-green-500 border-green-500" : "border-muted-foreground/40 hover:border-green-400"}`}
                    onClick={() => toggleCheck(item.id)}
                    aria-label={`Check ${item.label}`}
                    data-testid={`check-review-${item.id}`}
                    style={{ minWidth: 18, minHeight: 18 }}
                  >
                    {current.checklistDone[item.id] && <CheckCircle2 className="h-3 w-3 text-white" />}
                  </button>
                  <span className={`text-xs flex-1 ${current.checklistDone[item.id] ? "line-through text-muted-foreground" : ""}`}>{item.label}</span>
                  {item.link && (
                    <Link href={item.link}>
                      <span className="text-[10px] text-primary hover:underline whitespace-nowrap">{item.linkLabel}</span>
                    </Link>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 border-t">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Signups Target</label>
                <Input className="h-7 text-xs mt-1" placeholder="e.g. 50" value={current.signupsTarget} onChange={e => updateCurrent({ signupsTarget: e.target.value })} data-testid="input-review-target" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Signups Actual</label>
                <Input className="h-7 text-xs mt-1" placeholder="e.g. 38" value={current.signupsActual} onChange={e => updateCurrent({ signupsActual: e.target.value })} data-testid="input-review-actual" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Next Week's #1 Focus Channel</label>
              <Input className="h-7 text-xs mt-1" placeholder="e.g. LinkedIn, Partner Outreach, Blog..." value={current.focusChannel} onChange={e => updateCurrent({ focusChannel: e.target.value })} data-testid="input-review-focus" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Notes & Follow-ups</label>
              <Textarea className="text-xs mt-1" rows={4} placeholder="What worked? What missed? What's the #1 thing to fix next week?" value={current.notes} onChange={e => updateCurrent({ notes: e.target.value })} data-testid="input-review-notes" />
            </div>
            <Button className="w-full gap-2 text-xs" onClick={completeReview} data-testid="button-review-complete">
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark Review Complete
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">Last 4 Weeks</h3>
          {pastWeeks.length === 0 ? (
            <Card><CardContent className="pt-6 pb-6 text-center text-xs text-muted-foreground">No past reviews yet. Complete your first review to see history here.</CardContent></Card>
          ) : (
            pastWeeks.map(w => {
              const done = REVIEW_CHECKLIST.filter(i => w.checklistDone[i.id]).length;
              const pctW = Math.round((done / REVIEW_CHECKLIST.length) * 100);
              return (
                <Card key={w.weekKey} data-testid={`past-review-${w.weekKey}`}>
                  <CardContent className="pt-3 pb-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">{w.weekLabel}</span>
                      <div className="flex items-center gap-2">
                        {w.completedAt && <Badge className="text-[10px] bg-green-500 text-white">Completed</Badge>}
                        <Badge variant="secondary" className="text-[10px]">{done}/{REVIEW_CHECKLIST.length} checks</Badge>
                      </div>
                    </div>
                    <Progress value={pctW} className="h-1" />
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      {w.signupsActual && <span>Signups: <strong className="text-foreground">{w.signupsActual}</strong> / {w.signupsTarget || "?"}</span>}
                      {w.focusChannel && <span>Focus: <strong className="text-foreground">{w.focusChannel}</strong></span>}
                    </div>
                    {w.notes && <p className="text-xs text-muted-foreground line-clamp-2">{w.notes}</p>}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: SCORECARD
// ─────────────────────────────────────────────────────────────────────────────

const LS_SCORECARD = "gp_scorecard_v1";

interface ChannelRow {
  id: string;
  channel: string;
  owner: string;
  weeklyTarget: number;
  weeks: number[];
}

const DEFAULT_CHANNELS: ChannelRow[] = [
  { id: "linkedin", channel: "LinkedIn", owner: "", weeklyTarget: 3, weeks: [0, 0, 0, 0] },
  { id: "reddit", channel: "Reddit / Quora", owner: "", weeklyTarget: 10, weeks: [0, 0, 0, 0] },
  { id: "blog", channel: "Blog Posts", owner: "", weeklyTarget: 2, weeks: [0, 0, 0, 0] },
  { id: "youtube", channel: "YouTube", owner: "", weeklyTarget: 1, weeks: [0, 0, 0, 0] },
  { id: "haro", channel: "HARO / PR", owner: "", weeklyTarget: 3, weeks: [0, 0, 0, 0] },
  { id: "partner", channel: "Partner Outreach", owner: "", weeklyTarget: 10, weeks: [0, 0, 0, 0] },
  { id: "reviews", channel: "Review Requests", owner: "", weeklyTarget: 3, weeks: [0, 0, 0, 0] },
  { id: "gbp", channel: "Google Business Profile", owner: "", weeklyTarget: 1, weeks: [0, 0, 0, 0] },
  { id: "newsletter", channel: "Newsletter", owner: "", weeklyTarget: 1, weeks: [0, 0, 0, 0] },
];

function getMondayKey() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

function getStatusColor(actual: number, target: number) {
  if (target === 0) return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";
  const ratio = actual / target;
  if (ratio >= 1) return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
  if (ratio >= 0.6) return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300";
  return "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400";
}

function getStatusLabel(actual: number, target: number) {
  if (target === 0) return "—";
  const ratio = actual / target;
  if (ratio >= 1) return "On Track";
  if (ratio >= 0.6) return "Behind";
  return "Off Track";
}

function Sparkline({ weeks, target }: { weeks: number[]; target: number }) {
  const max = Math.max(target, ...weeks, 1);
  const w = 60; const h = 24; const pts = weeks.length;
  const points = weeks.map((v, i) => {
    const x = (i / (pts - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary opacity-60" />
      {weeks.map((v, i) => (
        <circle key={i} cx={(i / (pts - 1)) * w} cy={h - (v / max) * h} r="2" className={v >= target ? "fill-green-500" : v >= target * 0.6 ? "fill-yellow-500" : "fill-red-500"} />
      ))}
    </svg>
  );
}

function ScorecardTab() {
  const { toast } = useToast();
  const mondayKey = getMondayKey();

  const [channels, setChannels] = useState<ChannelRow[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SCORECARD) || "{}");
      if (saved.mondayKey === mondayKey) return saved.channels;
      if (saved.channels) {
        const shifted = (saved.channels as ChannelRow[]).map(c => ({
          ...c, weeks: [c.weeks[1] || 0, c.weeks[2] || 0, c.weeks[3] || 0, 0],
        }));
        return shifted;
      }
      return DEFAULT_CHANNELS;
    } catch { return DEFAULT_CHANNELS; }
  });

  useEffect(() => {
    localStorage.setItem(LS_SCORECARD, JSON.stringify({ mondayKey, channels }));
  }, [channels, mondayKey]);

  function update(id: string, field: keyof ChannelRow, value: string | number) {
    setChannels(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  }

  function updateThisWeek(id: string, value: number) {
    setChannels(prev => prev.map(c => {
      if (c.id !== id) return c;
      const weeks = [...c.weeks];
      weeks[3] = value;
      return { ...c, weeks };
    }));
  }

  function resetWeek() {
    setChannels(prev => prev.map(c => ({ ...c, weeks: [c.weeks[1] || 0, c.weeks[2] || 0, c.weeks[3] || 0, 0] })));
    toast({ title: "Scorecard reset for new week" });
  }

  const summary = useMemo(() => {
    const hits = channels.filter(c => c.weeklyTarget > 0 && c.weeks[3] >= c.weeklyTarget).length;
    const total = channels.filter(c => c.weeklyTarget > 0).length;
    return { hits, total, pct: total > 0 ? Math.round((hits / total) * 100) : 0 };
  }, [channels]);

  const weekLabels = Array.from({ length: 4 }, (_, i) => {
    const d = new Date(mondayKey);
    d.setDate(d.getDate() - (3 - i) * 7);
    return i === 3 ? "This Week" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2"><BarChart3 className="h-4 w-4 text-primary" /> Channel Scorecard</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Ownership + weekly targets. Resets automatically each Monday. Data saves in your browser.</p>
        </div>
        <Button size="sm" variant="outline" onClick={resetWeek} className="gap-1.5 text-xs" data-testid="button-scorecard-reset"><RefreshCw className="h-3.5 w-3.5" /> Reset to New Week</Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card><CardContent className="pt-4 pb-3 text-center">
          <div className={`text-2xl font-bold ${summary.pct >= 80 ? "text-green-600" : summary.pct >= 50 ? "text-yellow-600" : "text-red-600"}`}>{summary.pct}%</div>
          <div className="text-xs text-muted-foreground">Targets Hit This Week</div>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <div className="text-2xl font-bold text-green-600">{summary.hits}</div>
          <div className="text-xs text-muted-foreground">Channels On Track</div>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <div className="text-2xl font-bold text-muted-foreground">{summary.total - summary.hits}</div>
          <div className="text-xs text-muted-foreground">Channels Behind</div>
        </CardContent></Card>
      </div>

      <Progress value={summary.pct} className="h-2.5" />

      <Card>
        <CardContent className="pt-4 overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b">
                <th className="text-left px-2 py-2 font-semibold text-muted-foreground">Channel</th>
                <th className="text-left px-2 py-2 font-semibold text-muted-foreground">Owner</th>
                <th className="text-left px-2 py-2 font-semibold text-muted-foreground">Weekly Target</th>
                {weekLabels.map((label, i) => (
                  <th key={i} className={`text-left px-2 py-2 font-semibold ${i === 3 ? "text-foreground" : "text-muted-foreground"}`}>{label}</th>
                ))}
                <th className="text-left px-2 py-2 font-semibold text-muted-foreground">Status</th>
                <th className="text-left px-2 py-2 font-semibold text-muted-foreground">Trend</th>
              </tr>
            </thead>
            <tbody>
              {channels.map(c => {
                const thisWeek = c.weeks[3];
                const statusColor = getStatusColor(thisWeek, c.weeklyTarget);
                const statusLabel = getStatusLabel(thisWeek, c.weeklyTarget);
                return (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/20" data-testid={`scorecard-row-${c.id}`}>
                    <td className="px-2 py-2 font-medium">{c.channel}</td>
                    <td className="px-2 py-1.5">
                      <Input
                        className="h-7 text-xs w-24"
                        placeholder="Owner"
                        value={c.owner}
                        onChange={e => update(c.id, "owner", e.target.value)}
                        data-testid={`input-owner-${c.id}`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        className="h-7 text-xs w-16"
                        min={0}
                        value={c.weeklyTarget}
                        onChange={e => update(c.id, "weeklyTarget", Number(e.target.value))}
                        data-testid={`input-target-${c.id}`}
                      />
                    </td>
                    {c.weeks.slice(0, 3).map((v, i) => (
                      <td key={i} className="px-2 py-2 text-muted-foreground">{v}</td>
                    ))}
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        className="h-7 text-xs w-16 font-semibold"
                        min={0}
                        value={thisWeek}
                        onChange={e => updateThisWeek(c.id, Number(e.target.value))}
                        data-testid={`input-actual-${c.id}`}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Badge className={`text-[10px] ${statusColor}`}>{statusLabel}</Badge>
                    </td>
                    <td className="px-2 py-2">
                      <Sparkline weeks={c.weeks} target={c.weeklyTarget} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function GrowthPlaybook() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  function toggle(id: string) {
    setChecked(prev => ({ ...prev, [id]: !prev[id] }));
  }

  const totalTasks = useMemo(() => SECTIONS.flatMap(s => s.tasks).length, []);
  const completedTasks = useMemo(() => Object.values(checked).filter(Boolean).length, [checked]);
  const pct = Math.round((completedTasks / totalTasks) * 100);

  const tabIds = SECTIONS.map(s => s.id);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-green-500" /> Growth Playbook
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            End-to-end organic growth plan — from zero to 1,000 signups/week. Every item is free or near-free.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button asChild variant="outline" size="sm" data-testid="btn-ghl-guide-link">
            <Link href="/dashboard/ghl-sequence-guide">
              <Zap className="h-4 w-4 mr-1.5" /> GHL Sequence Guide
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" data-testid="btn-sequences-link">
            <Link href="/dashboard/sequences">
              <Mail className="h-4 w-4 mr-1.5" /> Sequences
            </Link>
          </Button>
        </div>
      </div>

      {/* Progress */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">Overall Progress</span>
            <span className="text-sm text-muted-foreground">{completedTasks} / {totalTasks} tasks complete</span>
          </div>
          <Progress value={pct} className="h-2.5" />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-muted-foreground">Check off tasks as you complete them — progress saves in your browser.</span>
            <Badge variant={pct >= 80 ? "default" : "secondary"} className="text-xs">{pct}%</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Architecture note */}
      <div className="flex gap-3 p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
        <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm text-blue-700 dark:text-blue-400">
          <span className="font-semibold">How to use this playbook: </span>
          Work through Phase 1 first — those tasks drive results within days. Run Phase 2 in parallel starting Week 2. Platform builds can be prioritized by clicking each task's detail. Check off items as you complete them.
        </div>
      </div>

      {/* Timeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Target className="h-4 w-4 text-green-500" /> Realistic Timeline to 1,000 Signups/Week
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4 font-semibold text-muted-foreground">Target</th>
                  <th className="text-left py-2 pr-4 font-semibold text-muted-foreground">When</th>
                  <th className="text-left py-2 font-semibold text-muted-foreground">Primary Drivers</th>
                </tr>
              </thead>
              <tbody>
                {TIMELINE.map((row, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2.5 pr-4 font-semibold text-green-600 dark:text-green-400">{row.milestone}</td>
                    <td className="py-2.5 pr-4 font-medium">{row.when}</td>
                    <td className="py-2.5 text-muted-foreground">{row.drivers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="cro">
        <div className="overflow-x-auto">
          <TabsList className="flex h-auto gap-1 w-max min-w-full mb-1">
            {SECTIONS.map(s => {
              const Icon = s.icon;
              const sectionDone = s.tasks.filter(t => checked[t.id]).length;
              return (
                <TabsTrigger key={s.id} value={s.id} className="flex items-center gap-1.5 text-xs whitespace-nowrap" data-testid={`tab-${s.id}`}>
                  <Icon className="h-3.5 w-3.5" />
                  {s.title.split(" — ")[0].replace("Phase 1 ", "P1 ").replace("Phase 2 ", "P2 ").replace("Phase 3", "P3").replace("Conversion Rate Optimization", "CRO").replace("Strategic Partnerships & Integrations", "Partnerships").replace("Podcast Guesting & Video", "Podcast/Video").replace("Community & Networking", "Community").replace("Review Generation Engine", "Reviews").replace("Platform Features to Build (Growth Unlocks)", "Builds").replace("Weekly Activity Tracker", "Weekly")}
                  {sectionDone > 0 && (
                    <Badge className="ml-0.5 h-4 px-1 text-[10px] bg-green-500 text-white">{sectionDone}</Badge>
                  )}
                </TabsTrigger>
              );
            })}
            <TabsTrigger value="tools" className="flex items-center gap-1.5 text-xs whitespace-nowrap" data-testid="tab-tools">
              <Wrench className="h-3.5 w-3.5" /> Tools
            </TabsTrigger>
            <TabsTrigger value="partner-pipeline" className="flex items-center gap-1.5 text-xs whitespace-nowrap" data-testid="tab-partner-pipeline">
              <Handshake className="h-3.5 w-3.5" /> Partner Pipeline
            </TabsTrigger>
            <TabsTrigger value="content-repurposing" className="flex items-center gap-1.5 text-xs whitespace-nowrap" data-testid="tab-content-repurposing">
              <Repeat2 className="h-3.5 w-3.5" /> Content Repurposing
            </TabsTrigger>
            <TabsTrigger value="weekly-review" className="flex items-center gap-1.5 text-xs whitespace-nowrap" data-testid="tab-weekly-review">
              <ListChecks className="h-3.5 w-3.5" /> Weekly Review
            </TabsTrigger>
            <TabsTrigger value="scorecard" className="flex items-center gap-1.5 text-xs whitespace-nowrap" data-testid="tab-scorecard">
              <BarChart3 className="h-3.5 w-3.5" /> Scorecard
            </TabsTrigger>
          </TabsList>
        </div>

        {SECTIONS.map(s => {
          const Icon = s.icon;
          const sectionDone = s.tasks.filter(t => checked[t.id]).length;
          return (
            <TabsContent key={s.id} value={s.id} className="mt-3">
              <Card>
                <CardHeader className="pb-2">
                  <div className={`border-l-4 ${s.color} pl-4`}>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Icon className="h-4 w-4" /> {s.title}
                    </CardTitle>
                    <CardDescription className="mt-1">{s.description}</CardDescription>
                    {s.weeklyTarget && (
                      <Badge variant="outline" className="mt-2 gap-1 text-xs w-fit">
                        <TrendingUp className="h-3 w-3" /> Target: {s.weeklyTarget}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground">Click any task to expand details and copy templates</span>
                    <Badge variant="secondary" className="text-xs">{sectionDone}/{s.tasks.length} done</Badge>
                  </div>
                  {s.tasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      checked={!!checked[task.id]}
                      onToggle={() => toggle(task.id)}
                    />
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}

        <TabsContent value="tools" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="border-l-4 border-primary pl-4">
                <CardTitle className="text-base flex items-center gap-2"><Wrench className="h-4 w-4" /> Tools — Growth Execution Stack</CardTitle>
                <CardDescription className="mt-1">Every platform tool and external resource that supports running this playbook. Click any card to open the tool.</CardDescription>
              </div>
            </CardHeader>
            <CardContent><ToolsTab /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="partner-pipeline" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="border-l-4 border-green-500 pl-4">
                <CardTitle className="text-base flex items-center gap-2"><Handshake className="h-4 w-4" /> Partner Outreach Pipeline</CardTitle>
                <CardDescription className="mt-1">Lightweight CRM for tracking every CPA, bookkeeper, insurance, and lender partner prospect. Saves locally in your browser.</CardDescription>
              </div>
            </CardHeader>
            <CardContent><PartnerPipelineTab /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="content-repurposing" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="border-l-4 border-purple-500 pl-4">
                <CardTitle className="text-base flex items-center gap-2"><Repeat2 className="h-4 w-4" /> Content Repurposing Workflow</CardTitle>
                <CardDescription className="mt-1">Turn one merchant statement review into 8 content outputs every week. Templates pre-filled — just swap in real numbers.</CardDescription>
              </div>
            </CardHeader>
            <CardContent><ContentRepurposingTab /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="weekly-review" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="border-l-4 border-blue-500 pl-4">
                <CardTitle className="text-base flex items-center gap-2"><ListChecks className="h-4 w-4" /> Weekly Review — 15 Minutes</CardTitle>
                <CardDescription className="mt-1">Structured Friday review: pull reports, score each channel, log signups vs. target, pick next week's focus. Saves 4 weeks of history.</CardDescription>
              </div>
            </CardHeader>
            <CardContent><WeeklyReviewTab /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scorecard" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="border-l-4 border-orange-500 pl-4">
                <CardTitle className="text-base flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Channel Scorecard</CardTitle>
                <CardDescription className="mt-1">Channel ownership + weekly targets. Auto red/yellow/green vs. target. Resets each Monday. 4-week sparkline per channel.</CardDescription>
              </div>
            </CardHeader>
            <CardContent><ScorecardTab /></CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
