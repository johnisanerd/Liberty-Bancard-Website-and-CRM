import { useState } from "react";
import { SEO } from "@/components/SEO";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import {
  Upload,
  Calendar,
  CheckCircle2,
  FileText,
  ShieldCheck,
  AlertCircle,
  ArrowRight,
  CreditCard,
  Monitor,
  Stethoscope,
  Car,
  UtensilsCrossed,
  Wrench,
  Store,
  ClipboardList,
  BarChart3,
  BookOpen,
  FolderOpen,
  Search,
} from "lucide-react";
import { CALENDAR_URL } from "@/lib/constants";
import imgCloverFlex3 from "@assets/images/terminal-clover-flex-3.png";
import imgCloverMini3 from "@assets/images/terminal-clover-mini-3.png";
import imgCloverStationDuo from "@assets/images/terminal-clover-station-duo.png";
import imgPaxA920 from "@assets/images/terminal-pax-a920.png";
import verticalMedical from "@assets/images/vertical-medical.jpg";
import verticalAuto from "@assets/images/vertical-auto.jpg";
import verticalRestaurant from "@assets/images/vertical-restaurant.jpg";
import verticalHomeServices from "@assets/images/vertical-home-services.jpg";
import verticalRetail from "@assets/images/vertical-retail.jpg";
import statementReview from "@assets/images/statement-review.jpg";
import securityUpload from "@assets/images/security-upload.jpg";
import merchantOwner from "@assets/images/merchant-owner.jpg";
import fundingDeposits from "@assets/images/funding-deposits.jpg";
import hiddenFees from "@assets/images/hidden-fees.jpg";
import zeroPercent from "@assets/images/zero-percent.jpg";
import complianceChecklist from "@assets/images/compliance-checklist.jpg";
import compareRates from "@assets/images/compare-rates.jpg";
import goLiveChecklist from "@assets/images/go-live-checklist.jpg";
import caseMedical from "@assets/images/case-medical.jpg";
import caseAuto from "@assets/images/case-auto.jpg";
import caseRestaurant from "@assets/images/case-restaurant.jpg";
import caseHomeServices from "@assets/images/case-home-services.jpg";
import caseRetail from "@assets/images/case-retail.jpg";

interface ContentPage {
  title: string;
  subtitle: string;
  description: string;
  bullets: string[];
  type: "standard" | "case-study" | "packet" | "index";
  stats?: { label: string; value: string }[];
  images?: { src: string; alt: string; caption?: string }[];
  caseStudy?: {
    snapshot: string;
    before: string;
    changed: string;
    after: string;
  };
  links?: { href: string; label: string; description: string }[];
  categories?: {
    name: string;
    items: { href: string; label: string }[];
  }[];
}

const contentMap: Record<string, ContentPage> = {
  "/assets": {
    title: "Asset Library",
    subtitle: "Sales Enablement Resources for Liberty Bancard",
    description: "Access one-pagers, comparison guides, terminal resources, vertical-specific collateral, and case studies. Everything you need to educate prospects and close deals.",
    bullets: [],
    type: "index",
    categories: [
      {
        name: "Start Here",
        items: [
          { href: "/assets/one-pagers/why-liberty", label: "Why Liberty Bancard" },
          { href: "/assets/one-pagers/how-statement-review-works", label: "How Statement Review Works" },
          { href: "/assets/one-pagers/funding-deposits-clarity", label: "Funding & Deposits Clarity" },
          { href: "/assets/one-pagers/hidden-fees-checklist", label: "Hidden Fees Checklist" },
          { href: "/assets/security/statement-upload-safety", label: "Statement Upload Safety" },
        ],
      },
      {
        name: "Programs + Competitive",
        items: [
          { href: "/assets/0-percent/overview", label: "0% Processing Overview" },
          { href: "/assets/0-percent/compliance-checklist", label: "0% Compliance Checklist" },
          { href: "/assets/compare/beat-square-stripe", label: "Beat Square & Stripe" },
        ],
      },
      {
        name: "Terminal",
        items: [
          { href: "/assets/terminal/smart-terminal", label: "Liberty Smart Terminal" },
          { href: "/assets/terminal/go-live-checklist", label: "Go-Live Checklist" },
        ],
      },
      {
        name: "Verticals",
        items: [
          { href: "/assets/verticals/medical", label: "Medical / Dental / Medspa" },
          { href: "/assets/verticals/auto", label: "Automotive" },
          { href: "/assets/verticals/restaurant", label: "Restaurant" },
          { href: "/assets/verticals/home-services", label: "Home Services" },
          { href: "/assets/verticals/retail", label: "Retail" },
          { href: "/assets/verticals/salon", label: "Salon / Beauty" },
          { href: "/assets/verticals/gym", label: "Gym / Fitness" },
          { href: "/assets/verticals/hotel", label: "Hotel / Hospitality" },
          { href: "/assets/verticals/legal", label: "Legal / Professional Services" },
          { href: "/assets/verticals/general", label: "General / Local Business" },
        ],
      },
      {
        name: "Case Studies",
        items: [
          { href: "/assets/case-studies/medical-front-desk", label: "Medical Front Desk" },
          { href: "/assets/case-studies/auto-high-ticket", label: "Automotive High-Ticket" },
          { href: "/assets/case-studies/restaurant-tips-speed", label: "Restaurant Tips & Speed" },
          { href: "/assets/case-studies/home-services-mobile", label: "Home Services Mobile" },
          { href: "/assets/case-studies/retail-fast-checkout", label: "Retail Fast Checkout" },
        ],
      },
    ],
  },

  "/assets/one-pagers/why-liberty": {
    title: "We Don't Quote Rates. We Diagnose Statements.",
    subtitle: "Why Liberty Bancard Is Different",
    description: "Most processors lead with a rate. We lead with a line-item statement review that shows you exactly what you're paying and why. No guessing, no bait-and-switch\u2014just transparent cost analysis before any proposal.",
    bullets: [
      "Free statement review with line-item cost breakdown",
      "Wholesale interchange-plus pricing with no hidden markups",
      "No long-term contracts or early termination fees",
      "Dedicated support from real humans, not call centers",
      "Compliance-first approach to every program we offer",
    ],
    type: "standard",
    stats: [
      { label: "Avg Statement Savings Found", value: "$1,247/mo" },
      { label: "Reviews Completed", value: "2,400+" },
      { label: "Avg Review Turnaround", value: "< 4 hrs" },
      { label: "Client Retention Rate", value: "96.8%" },
    ],
    images: [{ src: merchantOwner, alt: "Business owner at their point of sale", caption: "Real merchants. Real results. Real numbers." }],
  },

  "/assets/one-pagers/how-statement-review-works": {
    title: "What Happens After You Upload a Statement",
    subtitle: "Our Statement Review Process, Step by Step",
    description: "When you upload your merchant statement, our team performs a detailed cost analysis. We break down every fee, identify overcharges, and show you exactly where savings exist\u2014before you make any decisions.",
    bullets: [
      "Upload your most recent processing statement securely",
      "We identify interchange markups, junk fees, and hidden costs",
      "You receive a side-by-side comparison of current vs. optimized pricing",
      "No obligation to switch\u2014the review is free and confidential",
      "Average review turnaround is one business day",
    ],
    type: "standard",
    stats: [
      { label: "Statements Reviewed", value: "2,400+" },
      { label: "Avg Hidden Fees Found", value: "$680/mo" },
      { label: "Review Turnaround", value: "< 4 hrs" },
      { label: "Switch Rate After Review", value: "73%" },
    ],
    images: [{ src: statementReview, alt: "Processing statement analysis on desk", caption: "Every fee, every markup, every line item — analyzed." }],
  },

  "/assets/one-pagers/funding-deposits-clarity": {
    title: "Funding & Deposits: What to Expect",
    subtitle: "How and When You Get Paid",
    description: "Understanding your funding schedule eliminates surprises. We provide clear timelines on batch settlement, deposit timing, and reserve requirements so you always know when funds hit your account.",
    bullets: [
      "Next-day funding available for qualified merchants",
      "Clear batch cutoff times and settlement schedules",
      "Transparent reserve policies when applicable",
      "No hidden holds or unexplained delays",
    ],
    type: "standard",
    stats: [
      { label: "Next-Day Funding", value: "Available" },
      { label: "Batch Cutoff", value: "11 PM ET" },
      { label: "Avg Settlement", value: "< 24 hrs" },
      { label: "Reserve Requirement", value: "Rare" },
    ],
    images: [{ src: fundingDeposits, alt: "Business funding and cash flow management", caption: "Know exactly when your money arrives." }],
  },

  "/assets/one-pagers/hidden-fees-checklist": {
    title: "Common Hidden Fees We Find on Merchant Statements",
    subtitle: "Know What to Look For",
    description: "Many merchants pay fees they don't even know exist. This checklist highlights the most common junk fees, markups, and padding we uncover during statement reviews\u2014so you can spot them on your own statement.",
    bullets: [
      "PCI non-compliance fees charged without notification",
      "Batch processing fees and statement fees stacked together",
      "Inflated interchange markups disguised as flat rates",
      "Monthly minimum fees and annual fees buried in fine print",
      "Equipment lease costs far exceeding terminal value",
    ],
    type: "standard",
    stats: [
      { label: "Avg Junk Fees Found", value: "$487/mo" },
      { label: "Most Common Fee", value: "PCI Non-Compliance" },
      { label: "Statements with Hidden Fees", value: "89%" },
      { label: "Avg Fee Line Items", value: "14" },
    ],
    images: [{ src: hiddenFees, alt: "Analyzing merchant statement for hidden fees", caption: "89% of statements we review contain hidden fees." }],
  },

  "/assets/security/statement-upload-safety": {
    title: "Statement Upload: Secure, Minimal, and Optional Redactions",
    subtitle: "Your Data Privacy Is Our Priority",
    description: "We only need the fee summary and transaction totals from your statement. You can redact account numbers, merchant IDs, and any other sensitive data before uploading. Our upload process uses bank-grade encryption.",
    bullets: [
      "TLS encryption on all uploads",
      "You may redact any personally identifiable information",
      "We only analyze fee lines and volume totals",
      "Statements are deleted after review unless you request otherwise",
      "No data is shared with third parties",
    ],
    type: "standard",
    stats: [
      { label: "Encryption Standard", value: "256-bit TLS" },
      { label: "Data Retention", value: "30 Days" },
      { label: "Third-Party Sharing", value: "Never" },
      { label: "PCI Compliance", value: "Level 1" },
    ],
    images: [{ src: securityUpload, alt: "Secure data protection and encryption", caption: "Bank-grade encryption protects every upload." }],
  },

  "/assets/0-percent/overview": {
    title: "'0% Processing' Has Rules. We Do It the Right Way.",
    subtitle: "Compliant Cash Discount and Surcharge Programs",
    description: "Zero-cost processing is real, but only when done within card brand rules and state law. We build compliant programs that protect your business from fines and chargebacks while passing processing costs to cardholders the right way.",
    bullets: [
      "Compliant with Visa, Mastercard, and state-level regulations",
      "Proper signage, receipt language, and disclosure requirements",
      "Cash discount and dual-pricing options available",
      "Regular compliance audits to keep your program current",
      "We handle setup, training, and ongoing support",
    ],
    type: "standard",
    stats: [
      { label: "Merchants on 0% Programs", value: "680+" },
      { label: "Compliance Rate", value: "100%" },
      { label: "Avg Savings for Merchant", value: "$2,100/mo" },
      { label: "States Supported", value: "48" },
    ],
    images: [{ src: zeroPercent, alt: "Payment terminal for zero-cost processing", caption: "Compliant 0% programs built the right way." }],
  },

  "/assets/0-percent/compliance-checklist": {
    title: "0% Processing Compliance Checklist",
    subtitle: "Requirements for a Compliant Zero-Cost Program",
    description: "Before launching a 0% processing program, you need to meet specific card brand and legal requirements. This checklist covers signage, receipt formatting, state eligibility, and disclosure rules.",
    bullets: [
      "Verify state-level legality for surcharging or cash discount",
      "Register surcharge program with card brands (if applicable)",
      "Install compliant signage at point of entry and point of sale",
      "Ensure receipts show surcharge as a separate line item",
      "Train staff on how to explain the program to customers",
    ],
    type: "standard",
    stats: [
      { label: "Checklist Items", value: "12" },
      { label: "States with Restrictions", value: "2" },
      { label: "Setup Time", value: "< 48 hrs" },
      { label: "Ongoing Audit Frequency", value: "Quarterly" },
    ],
    images: [{ src: complianceChecklist, alt: "Compliance checklist and requirements", caption: "12 steps to a fully compliant program." }],
  },

  "/assets/compare/beat-square-stripe": {
    title: "Flat-Rate Is Convenient \u2014 Until You See the All-In Cost",
    subtitle: "Square & Stripe vs. Interchange-Plus Pricing",
    description: "Flat-rate processors like Square and Stripe charge the same rate regardless of card type. That means you overpay on debit and standard credit cards. Our interchange-plus model passes through actual card costs with a transparent margin.",
    bullets: [
      "Square/Stripe charge 2.6%+ on every transaction regardless of card type",
      "Debit cards cost as low as 0.05% at interchange\u2014flat-rate ignores this",
      "Interchange-plus pricing shows exactly what you pay per transaction",
      "Merchants processing $10K+/month typically save significantly",
      "No proprietary hardware lock-in with Liberty Bancard",
      "At $25K/month volume with 40% debit: Square costs ~$725/mo; Liberty Bancard costs ~$410/mo",
      "At $50K/month volume with 50% debit: Stripe costs ~$1,430/mo; Liberty Bancard costs ~$690/mo",
      "No monthly fee, no annual fee, no PCI fee, no statement fee with Liberty Bancard",
      "Real savings example: A $50 debit transaction costs $1.30 on Square vs. $0.30 on interchange-plus",
    ],
    type: "standard",
    stats: [
      { label: "Avg Savings vs. Flat-Rate", value: "31%" },
      { label: "Debit Card Savings", value: "Up to 85%" },
      { label: "Break-Even Volume", value: "$8K/mo" },
      { label: "Merchants Switched", value: "1,100+" },
    ],
    images: [{ src: compareRates, alt: "Comparing flat-rate vs interchange-plus pricing", caption: "Side-by-side: where flat-rate processors overcharge." }],
  },

  "/assets/terminal/smart-terminal": {
    title: "Liberty Smart Terminal",
    subtitle: "Modern, Reliable, and Ready for Any Payment Type",
    description: "The Liberty Smart Terminal is a full-featured countertop payment device that accepts tap, dip, swipe, and QR payments. It supports dual-pricing, tip adjustment, and integrates with most POS systems out of the box. Built for businesses that need reliability and compliance from day one.",
    bullets: [
      "Accepts EMV chip, contactless/NFC, magstripe, and QR codes",
      "Built-in support for cash discount and surcharge programs",
      "Wi-Fi and Ethernet connectivity",
      "Tip adjust, batch close, and reporting from the terminal",
      "Compact countertop form factor with touchscreen display",
      "Liberty Bancard branding and dedicated support",
    ],
    type: "standard",
    stats: [
      { label: "Payment Types", value: "Tap/Dip/Swipe/QR" },
      { label: "Authorization Speed", value: "< 2 sec" },
      { label: "Connectivity", value: "Wi-Fi + Ethernet" },
      { label: "Warranty", value: "2 Years" },
    ],
    images: [
      { src: imgCloverFlex3, alt: "Clover Flex 3 handheld POS terminal", caption: "Clover Flex 3 - portable all-in-one payment device" },
      { src: imgCloverStationDuo, alt: "Clover Station Duo full register system", caption: "Clover Station Duo - complete countertop register" },
      { src: imgCloverMini3, alt: "Clover Mini 3 compact countertop POS", caption: "Clover Mini 3 - compact and powerful" },
      { src: imgPaxA920, alt: "PAX A920 smart payment terminal", caption: "PAX A920 - sleek smart terminal" },
    ],
  },

  "/assets/terminal/go-live-checklist": {
    title: "Terminal Go-Live Checklist",
    subtitle: "Everything You Need Before Your First Transaction",
    description: "Use this checklist to ensure your terminal is properly configured, tested, and ready for live transactions. Covers connectivity, batch testing, signage (for 0% programs), and staff training.",
    bullets: [
      "Confirm internet connectivity (Wi-Fi or Ethernet)",
      "Run a test transaction and verify batch settlement",
      "Install compliant signage if running a 0% program",
      "Train staff on void, refund, and tip-adjust functions",
      "Save Liberty Bancard support number in a visible location",
    ],
    type: "standard",
    stats: [
      { label: "Steps to Go Live", value: "8" },
      { label: "Avg Setup Time", value: "< 30 min" },
      { label: "Test Transactions", value: "2 Required" },
      { label: "Support Available", value: "24/7" },
    ],
    images: [{ src: goLiveChecklist, alt: "Terminal setup preparation checklist", caption: "8 steps to a flawless first transaction." }],
  },

  "/assets/verticals/medical": {
    title: "Medical/Dental/Medspa Processing",
    subtitle: "Payment Solutions for Healthcare Practices",
    description: "Healthcare practices handle high-ticket transactions, recurring billing, and patient financing. We provide HIPAA-aware payment solutions with compliant 0% programs, next-day funding, and terminal configurations designed for front-desk workflows.",
    bullets: [
      "High-ticket transaction optimization reduces per-visit costs",
      "Compliant 0% programs for elective and cosmetic procedures",
      "Next-day funding for improved cash flow",
      "Terminal configurations for front desk and multi-location setups",
      "Recurring billing support for payment plans",
    ],
    type: "standard",
    stats: [
      { label: "Avg Ticket", value: "$350+" },
      { label: "Elective Procedure Savings", value: "Up to 100%" },
      { label: "Practices Served", value: "140+" },
      { label: "Avg Monthly Savings", value: "$1,800" },
    ],
    images: [{ src: verticalMedical, alt: "Medical office reception and payment area", caption: "Payment solutions built for healthcare workflows." }],
  },

  "/assets/verticals/auto": {
    title: "Automotive Processing",
    subtitle: "Payment Solutions for Auto Shops and Dealers",
    description: "Automotive businesses process large repair orders and parts purchases. Our interchange-plus pricing eliminates the flat-rate penalty on high-ticket transactions, and our terminals support tip adjust and invoice-based payments.",
    bullets: [
      "Interchange-plus pricing saves on high-ticket repair orders",
      "Terminal support for invoice and keyed-entry transactions",
      "Compliant 0% programs to offset processing costs",
      "Next-day funding keeps parts inventory moving",
      "Multi-bay and multi-location terminal deployment",
    ],
    type: "standard",
    stats: [
      { label: "Avg Repair Ticket", value: "$580+" },
      { label: "Debit Savings per Transaction", value: "$12.40" },
      { label: "Shops Served", value: "95+" },
      { label: "Avg Monthly Savings", value: "$850" },
    ],
    images: [{ src: verticalAuto, alt: "Auto repair shop service bay", caption: "High-ticket repair orders deserve better rates." }],
  },

  "/assets/verticals/restaurant": {
    title: "Restaurant Processing",
    subtitle: "Payment Solutions for Restaurants and Quick-Service",
    description: "Restaurants need fast authorization, reliable tip adjust, and equipment that handles high-volume rushes. We provide optimized terminal configurations, competitive interchange-plus rates, and compliant 0% programs for dine-in and counter-service environments.",
    bullets: [
      "Fast authorization speeds for high-volume service",
      "Tip adjust and pre-auth support built into terminals",
      "Compliant 0% programs for dine-in and counter service",
      "Interchange-plus pricing reduces cost on debit-heavy ticket mixes",
      "Integration options for POS systems",
    ],
    type: "standard",
    stats: [
      { label: "Avg Daily Transactions", value: "200+" },
      { label: "Debit Mix Savings", value: "Up to 55%" },
      { label: "Restaurants Served", value: "210+" },
      { label: "Tip Adjust Accuracy", value: "99.9%" },
    ],
    images: [{ src: verticalRestaurant, alt: "Restaurant dining area and service", caption: "Fast authorization and reliable tip settlement." }],
  },

  "/assets/verticals/home-services": {
    title: "Home Services Processing",
    subtitle: "Payment Solutions for Field Service Businesses",
    description: "Home service providers need mobile payment acceptance, fast funding, and the ability to process payments on-site. We offer mobile terminal options, virtual terminal access, and compliant programs for contractors, HVAC, plumbing, and more.",
    bullets: [
      "Mobile terminal options for on-site payment collection",
      "Virtual terminal for phone and invoice payments",
      "Next-day funding to cover materials and payroll",
      "Compliant 0% programs for high-ticket service calls",
      "Simple setup with no long-term contracts",
    ],
    type: "standard",
    stats: [
      { label: "Avg Service Ticket", value: "$450+" },
      { label: "Field Payment Rate", value: "85%+" },
      { label: "Contractors Served", value: "120+" },
      { label: "Collection Cycle", value: "< 1 Day" },
    ],
    images: [{ src: verticalHomeServices, alt: "Home services technician on the job", caption: "Accept payments wherever the job takes you." }],
  },

  "/assets/verticals/retail": {
    title: "Retail Processing",
    subtitle: "Payment Solutions for Retail Stores",
    description: "Retail merchants process a high volume of card-present transactions across multiple card types. Interchange-plus pricing ensures you pay actual interchange on debit cards instead of inflated flat rates, and our terminals handle tap, dip, and swipe seamlessly.",
    bullets: [
      "Interchange-plus pricing maximizes savings on debit and credit mix",
      "Contactless and EMV chip acceptance standard",
      "Compliant 0% programs available for qualifying stores",
      "Fast batch settlement and next-day funding options",
      "Countertop and mobile terminal configurations",
    ],
    type: "standard",
    stats: [
      { label: "Avg Daily Volume", value: "300+ txns" },
      { label: "Debit Optimization", value: "Up to 80%" },
      { label: "Stores Served", value: "175+" },
      { label: "Checkout Speed", value: "< 3 sec" },
    ],
    images: [{ src: verticalRetail, alt: "Retail store checkout experience", caption: "Tap-to-pay checkout in under 3 seconds." }],
  },

  "/assets/verticals/salon": {
    title: "Salon & Beauty Processing",
    subtitle: "Payment Solutions for Salons, Spas, and Beauty Studios",
    description: "Salons and beauty studios run a high volume of low-to-mid ticket transactions, often combined with deposits, memberships, or card-on-file booking. A statement review typically focuses on whether debit transactions are billed at a flat rate instead of true interchange, and whether recurring/booking fees are itemized clearly.",
    bullets: [
      "Ask what percentage of tickets are debit cards — flat-rate pricing usually overcharges on debit-heavy mixes",
      "Confirm how deposits, cancellation fees, and memberships are currently processed",
      "Tip-adjust accuracy matters for stylist and technician payroll reconciliation",
      "Compliant 0% / dual-pricing programs may apply for service-based tickets — verify eligibility before quoting",
      "Statement review angle: look for a PCI non-compliance fee and separately billed gateway/booking-platform fees",
    ],
    type: "standard",
  },

  "/assets/verticals/gym": {
    title: "Gym & Fitness Processing",
    subtitle: "Payment Solutions for Gyms, Studios, and Fitness Centers",
    description: "Gyms and fitness studios depend on reliable recurring membership billing, so decline/retry handling and chargeback support for cancelled memberships matter as much as per-transaction rate. A statement review should separate recurring-billing/ACH fees from card-present terminal fees, since they're often billed differently.",
    bullets: [
      "Ask which recurring billing platform is used and whether it's billed separately from card-present processing",
      "Confirm current decline/retry logic for expired or replaced membership cards",
      "Chargeback volume from cancelled memberships is common — ask about current dispute support",
      "Compliant 0% / dual-pricing programs may apply for walk-in or day-pass transactions — verify eligibility before quoting",
      "Statement review angle: check for a monthly minimum fee on lower-volume locations",
    ],
    type: "standard",
  },

  "/assets/verticals/hotel": {
    title: "Hotel & Hospitality Processing",
    subtitle: "Payment Solutions for Hotels, Inns, and Short-Term Lodging",
    description: "Hospitality merchants deal with pre-authorizations, incidental holds, higher-than-average tickets, and a heavier mix of corporate/rewards cards, which typically carry higher interchange. A statement review should confirm whether the current provider is billing those cards at a padded non-qualified rate instead of passing through actual interchange.",
    bullets: [
      "Ask about current pre-auth and no-show/incidental hold handling",
      "Corporate and rewards cards carry higher interchange — confirm whether the current statement shows a inflated 'non-qualified' surcharge on them",
      "Property management system (PMS) or booking engine integration needs should be scoped before recommending a terminal or gateway",
      "Seasonal volume swings may affect which pricing structure makes sense — ask about peak vs. off-season volume",
      "Statement review angle: check for stacked gateway, PCI, and batch fees common on legacy hospitality processors",
    ],
    type: "standard",
  },

  "/assets/verticals/legal": {
    title: "Legal & Professional Services Processing",
    subtitle: "Payment Solutions for Law Firms, CPAs, and Consultants",
    description: "Legal and professional-services firms tend to have lower transaction volume but higher average tickets, invoice-based billing, and in some cases trust or IOLTA accounts. A statement review should flag monthly minimum fees on low-volume accounts, and any trust-account processing question should be routed to the firm's own compliance/bar guidance before recommending a setup.",
    bullets: [
      "Ask whether the firm operates a trust or IOLTA account — fees should never be deducted directly from trust balances; confirm the firm's own compliance requirements before proposing a structure",
      "Invoice-based and virtual terminal billing is common — confirm how retainers and one-time invoices are currently collected",
      "Lower transaction volume can mean a flat monthly minimum fee is quietly inflating the effective rate — check for one on the statement",
      "Ask about current keyed-entry vs. card-present mix, since keyed rates are usually higher",
      "Statement review angle: confirm whether recurring retainer billing is itemized separately from one-time invoice payments",
    ],
    type: "standard",
  },

  "/assets/verticals/general": {
    title: "General & Local Business Processing",
    subtitle: "Payment Solutions for Any Local Business",
    description: "For verticals not covered by a dedicated packet, the fundamentals of a good statement review still apply: identify the actual interchange-plus cost versus what's being billed, flag junk and non-compliance fees, and confirm whether a compliant 0% or terminal upgrade makes sense for this specific business. Use this packet as a starting point and pull in vertical-specific materials once the business type is confirmed.",
    bullets: [
      "Request the merchant's most recent processing statement before quoting anything",
      "Look for common junk fees: PCI non-compliance, statement fee, batch fee, or an unexplained gateway fee",
      "Confirm current debit vs. credit mix — flat-rate pricing tends to overcharge on debit-heavy businesses",
      "Ask whether a compliant 0% / dual-pricing program or a terminal upgrade fits this business's transaction style",
      "If a more specific vertical becomes clear (restaurant, medical, retail, etc.), switch to that packet for more targeted talking points",
    ],
    type: "standard",
  },

  "/assets/case-studies/medical-front-desk": {
    title: "Case Study: Prestige Dermatology & Medspa",
    subtitle: "How a Multi-Location Healthcare Practice Reduced Processing Costs by 53%",
    description: "Prestige Dermatology & Medspa in Coral Springs, FL was overpaying on flat-rate processing across three locations, paying identical rates on $15 insurance copays and $2,500 Botox packages. After a detailed statement review, Liberty Bancard eliminated $1,560/month in junk fees, deployed interchange-plus pricing, and implemented a compliant cash discount program for elective services.",
    bullets: [],
    type: "case-study",
    images: [{ src: caseMedical, alt: "Dermatology and medspa practice", caption: "Prestige Dermatology & Medspa — Coral Springs, FL" }],
    stats: [
      { label: "Avg Ticket", value: "$420" },
      { label: "Monthly Volume", value: "$94K" },
      { label: "Rate Reduced", value: "3.12% to 1.48%" },
      { label: "Annual Savings", value: "$18,700" },
    ],
    caseStudy: {
      snapshot: "Multi-provider dermatology and medspa practice with 3 locations, processing $94,000/month across 224 transactions. Mix of insurance copays (lower ticket) and elective cosmetic procedures (high ticket $800-$2,500).",
      before: "Locked into flat-rate contract at 2.9% + $0.30 with a national aggregator. Paying identical rates on $15 copay cards and $2,500 Botox packages. No debit optimization. Monthly fees included $129 PCI compliance fee, $25 statement fee, and $95 gateway fee. Effective all-in rate: 3.12%.",
      changed: "Liberty Bancard performed a line-item statement review revealing $1,560/month in junk fees alone. Migrated to interchange-plus at cost + 0.20% / $0.08. Deployed compliant cash discount program for all elective/cosmetic services. Installed 3 Liberty Smart Terminals with front-desk configurations. Retained traditional pricing for insurance copay transactions.",
      after: "Effective rate dropped to 1.48% blended. Elective procedure transactions now at true 0% through compliant cash discount program. Junk fees eliminated. Net savings of $18,700/year. Funding improved from T+2 to next-day.",
    },
  },

  "/assets/case-studies/auto-high-ticket": {
    title: "Case Study: Summit Auto Repair & Performance",
    subtitle: "How a European Auto Shop Cut Processing Costs by 47%",
    description: "Summit Auto Repair & Performance in Boca Raton, FL specializes in European vehicles and was losing margin on high-ticket repair orders processed through a flat-rate POS-integrated provider. Liberty Bancard's interchange-plus pricing and compliant surcharge program recovered $10,200 in annual savings.",
    bullets: [],
    type: "case-study",
    images: [{ src: caseAuto, alt: "Auto repair and performance shop", caption: "Summit Auto Repair & Performance — Boca Raton, FL" }],
    stats: [
      { label: "Avg Ticket", value: "$680" },
      { label: "Monthly Volume", value: "$62K" },
      { label: "Rate Reduced", value: "2.89% to 1.52%" },
      { label: "Annual Savings", value: "$10,200" },
    ],
    caseStudy: {
      snapshot: "Independent auto repair and performance shop, 4 bays, specializing in European vehicles. Processing $62,000/month across 91 transactions. High-ticket repair orders from $400-$3,800.",
      before: "Using a well-known POS-integrated processor at 2.75% + $0.25 flat rate. Keyed-entry transactions (phone orders for parts) charged at 3.5% + $0.30. Monthly minimum fee of $25 plus $19.95 equipment lease on outdated terminal. Effective rate: 2.89%.",
      changed: "Statement review identified $840/month in interchange overcharges on debit cards alone. Switched to interchange-plus at cost + 0.25% / $0.10. Deployed Liberty Smart Terminal with keyed-entry and invoice support. Implemented compliant surcharge program for credit card transactions over $500. Eliminated equipment lease.",
      after: "Effective rate reduced to 1.52%. Debit transactions now processing at actual interchange (avg 0.05% + $0.22). Surcharge program offsets costs on large repair orders. Annual savings of $10,200. Terminal paid for itself in 6 weeks.",
    },
  },

  "/assets/case-studies/restaurant-tips-speed": {
    title: "Case Study: Coastal Tavern Kitchen & Bar",
    subtitle: "How a Full-Service Restaurant Fixed Tip Settlement and Saved $7,400/Year",
    description: "Coastal Tavern Kitchen & Bar in Fort Lauderdale, FL was experiencing 4-second authorization delays during dinner rush, $1,200/month in tip-adjust reconciliation errors, and cash-flow gaps from delayed batch settlement. Liberty Bancard deployed optimized terminals, switched to interchange-plus pricing, and eliminated every operational bottleneck.",
    bullets: [],
    type: "case-study",
    images: [{ src: caseRestaurant, alt: "Restaurant and bar dining experience", caption: "Coastal Tavern Kitchen & Bar — Fort Lauderdale, FL" }],
    stats: [
      { label: "Avg Ticket", value: "$38" },
      { label: "Daily Transactions", value: "340" },
      { label: "Rate Reduced", value: "2.71% to 1.62%" },
      { label: "Annual Savings", value: "$7,400" },
    ],
    caseStudy: {
      snapshot: "Full-service restaurant and bar, 120 seats, open 7 days. Processing $388,000/month across ~10,200 transactions. Heavy debit card usage (55% of transactions). High tip-adjust volume.",
      before: "National restaurant processor charging 2.6% + $0.10 flat rate. Tip-adjust failures causing $1,200/month in reconciliation issues. Batch settlement delayed until 6 AM causing cash-flow gaps. Terminal firmware outdated, causing 4-second authorization times during dinner rush. Effective rate: 2.71%.",
      changed: "Deployed 4 Liberty Smart Terminals with optimized tip-adjust workflow and 1-second authorization. Switched to interchange-plus pricing to capture debit savings (55% of volume at ~0.05% + $0.22 interchange vs. 2.6% flat). Configured batch auto-close at 11 PM for same-night settlement. Staff trained on void, refund, and pre-auth procedures.",
      after: "Authorization speed improved from 4 seconds to under 1 second. Tip settlement errors eliminated. Effective rate dropped to 1.62% (driven by debit optimization). Annual savings of $7,400. Funding moved to next-day. No more morning cash-flow gaps.",
    },
  },

  "/assets/case-studies/home-services-mobile": {
    title: "Case Study: ProFlow Plumbing & HVAC",
    subtitle: "How a Field Service Company Reduced Collection from 11 Days to 1",
    description: "ProFlow Plumbing & HVAC in Pompano Beach, FL was collecting 80% of payments via paper invoice with an 11-day average collection cycle and $1,800/month in write-offs. Liberty Bancard deployed mobile terminals to all 6 service trucks, set up virtual terminal billing, and implemented a compliant cash discount program that transformed their cash flow.",
    bullets: [],
    type: "case-study",
    images: [{ src: caseHomeServices, alt: "HVAC and plumbing service vehicle", caption: "ProFlow Plumbing & HVAC — Pompano Beach, FL" }],
    stats: [
      { label: "Avg Ticket", value: "$520" },
      { label: "Service Trucks", value: "6" },
      { label: "Collection Cycle", value: "11 days to 1" },
      { label: "Annual Savings", value: "$9,100" },
    ],
    caseStudy: {
      snapshot: "Residential and light commercial plumbing and HVAC company with 6 service trucks and a central dispatch office. Processing $47,000/month across 90 field transactions and 35 office-invoiced jobs.",
      before: "80% of payments collected via paper invoice with check. Average collection cycle: 11 days. Remaining 20% processed through a virtual terminal at 3.4% + $0.30 (keyed-entry rate). No mobile payment capability. Monthly write-offs for uncollected invoices averaged $1,800.",
      changed: "Deployed 6 mobile terminals (one per truck) for on-site card acceptance. Set up virtual terminal for office billing and recurring maintenance contracts. Implemented compliant cash discount program for field transactions over $300. Integrated with dispatch software for same-day invoicing and payment confirmation.",
      after: "Card acceptance rate jumped from 20% to 85%. Average collection cycle reduced from 11 days to 1 day. Monthly write-offs dropped from $1,800 to $200. Effective processing rate of 1.38% (with cash discount offsetting large jobs). Annual savings and recovered revenue: $9,100 in fee reductions plus $19,200 in reduced write-offs.",
    },
  },

  "/assets/case-studies/retail-fast-checkout": {
    title: "Case Study: Harbor Surf & Skate Shop",
    subtitle: "How a Retail Store Cut Checkout Time by 63% and Saved $11,600/Year",
    description: "Harbor Surf & Skate Shop in Deerfield Beach, FL was processing over 11,000 transactions per month through a legacy flat-rate processor with 6-8 second chip-read times, no contactless support, and a hidden PCI non-compliance fee. Liberty Bancard deployed tap-to-pay terminals, switched to interchange-plus pricing, and implemented a dual-pricing program that delivered $11,600 in annual savings.",
    bullets: [],
    type: "case-study",
    images: [{ src: caseRetail, alt: "Surf and skate retail store", caption: "Harbor Surf & Skate Shop — Deerfield Beach, FL" }],
    stats: [
      { label: "Avg Ticket", value: "$32" },
      { label: "Daily Transactions", value: "380" },
      { label: "Checkout Time", value: "8s to 3s" },
      { label: "Annual Savings", value: "$11,600" },
    ],
    caseStudy: {
      snapshot: "Specialty surf and skate retail store with high foot traffic. Processing $365,000/month across ~11,400 transactions. 62% debit card usage. Peak volume during summer months.",
      before: "Legacy flat-rate processor at 2.6% + $0.10. Old chip-only terminal with 6-8 second read times causing checkout line backups. No contactless/tap support. PCI non-compliance fee of $39.95/month charged without merchant's knowledge. Effective rate: 2.78%.",
      changed: "Deployed 2 Liberty Smart Terminals with contactless/NFC support for tap-to-pay. Switched to interchange-plus pricing to capture savings on 62% debit volume. Implemented compliant dual-pricing program with clear shelf and register signage. Eliminated PCI non-compliance fee through proper compliance portal setup.",
      after: "Checkout time reduced from 6-8 seconds to under 3 seconds with tap-to-pay. Effective rate dropped to 1.82% (debit transactions at ~$0.24 each vs. $0.93 under flat-rate). Dual-pricing program offsets remaining credit card costs. Annual savings of $11,600. Customer satisfaction improved with faster checkout.",
    },
  },

  "/packet/statement-review": {
    title: "Statement Review Packet",
    subtitle: "Everything a Prospect Needs to Understand Our Review Process",
    description: "This packet contains the key resources for educating prospects on why Liberty Bancard is different, how our statement review works, and what hidden fees we commonly find. Share these before or after a statement upload.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/one-pagers/why-liberty", label: "Why Liberty Bancard", description: "Our approach: diagnose first, quote second." },
      { href: "/assets/one-pagers/how-statement-review-works", label: "How Statement Review Works", description: "Step-by-step breakdown of our review process." },
      { href: "/assets/one-pagers/hidden-fees-checklist", label: "Hidden Fees Checklist", description: "Common junk fees and markups we identify." },
    ],
  },

  "/packet/estimate": {
    title: "Estimate Packet",
    subtitle: "Resources for Prospects Requesting a Cost Estimate",
    description: "Share these resources with merchants who want to understand pricing and funding before committing. Covers the review process and what to expect from deposits and settlement.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/one-pagers/how-statement-review-works", label: "How Statement Review Works", description: "Step-by-step review process overview." },
      { href: "/assets/one-pagers/funding-deposits-clarity", label: "Funding & Deposits Clarity", description: "Settlement timelines and funding details." },
    ],
  },

  "/packet/0-percent": {
    title: "0% Processing Packet",
    subtitle: "Resources for Merchants Interested in Zero-Cost Processing",
    description: "This packet explains how compliant 0% processing works, including the legal and card brand requirements. Share with merchants evaluating cash discount or surcharge programs.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/0-percent/overview", label: "0% Processing Overview", description: "How we build compliant zero-cost programs." },
      { href: "/assets/0-percent/compliance-checklist", label: "Compliance Checklist", description: "Requirements for signage, receipts, and state eligibility." },
    ],
  },

  "/packet/terminal": {
    title: "Terminal Packet",
    subtitle: "Resources for Terminal Deployment and Setup",
    description: "Everything a merchant needs for a smooth terminal rollout. Covers the Liberty Smart Terminal features and a pre-launch checklist to ensure day-one readiness.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/terminal/smart-terminal", label: "Liberty Smart Terminal", description: "Terminal specs, features, and payment types supported." },
      { href: "/assets/terminal/go-live-checklist", label: "Go-Live Checklist", description: "Pre-launch steps for connectivity, testing, and training." },
    ],
  },

  "/packet/beat-square-stripe": {
    title: "Beat Square & Stripe Packet",
    subtitle: "Competitive Comparison Resources",
    description: "Use this packet when speaking with merchants currently on Square or Stripe. The comparison guide shows how interchange-plus pricing eliminates the flat-rate penalty on debit and standard credit cards.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/compare/beat-square-stripe", label: "Flat-Rate vs. Interchange-Plus", description: "Side-by-side cost comparison showing where flat-rate overpays." },
    ],
  },

  "/packet/medical": {
    title: "Medical Vertical Packet",
    subtitle: "Payment Processing Resources for Healthcare Practices",
    description: "Tailored resources for medical, dental, and medspa practices. Covers high-ticket optimization, compliant 0% programs, and a case study from a similar practice.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/medical", label: "Medical Processing Overview", description: "Solutions for healthcare payment workflows." },
      { href: "/assets/case-studies/medical-front-desk", label: "Case Study: Medical Front Desk", description: "Real-world results from a multi-provider practice." },
      { href: "/assets/0-percent/overview", label: "0% Processing Overview", description: "Compliant programs for elective procedures." },
    ],
  },

  "/packet/auto": {
    title: "Automotive Vertical Packet",
    subtitle: "Payment Processing Resources for Auto Shops and Dealers",
    description: "Resources for automotive businesses processing high-ticket repair orders and parts sales. Covers interchange-plus savings, terminal options, and a case study from a similar shop.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/auto", label: "Automotive Processing Overview", description: "Solutions for auto shops and dealers." },
      { href: "/assets/case-studies/auto-high-ticket", label: "Case Study: Auto High-Ticket", description: "How an auto shop cut costs on large orders." },
      { href: "/assets/terminal/smart-terminal", label: "Liberty Smart Terminal", description: "Terminal with invoice and keyed-entry support." },
    ],
  },

  "/packet/restaurant": {
    title: "Restaurant Vertical Packet",
    subtitle: "Payment Processing Resources for Restaurants",
    description: "Resources for restaurants and quick-service environments. Covers tip-adjust optimization, fast authorization, and a case study from a busy restaurant.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/restaurant", label: "Restaurant Processing Overview", description: "Solutions for dine-in and counter service." },
      { href: "/assets/case-studies/restaurant-tips-speed", label: "Case Study: Tips & Speed", description: "Faster authorizations and reliable tip settlement." },
      { href: "/assets/terminal/smart-terminal", label: "Liberty Smart Terminal", description: "Terminal configured for high-volume restaurant use." },
    ],
  },

  "/packet/home-services": {
    title: "Home Services Vertical Packet",
    subtitle: "Payment Processing Resources for Field Service Businesses",
    description: "Resources for contractors, HVAC, plumbing, and other field service businesses. Covers mobile payment options, next-day funding, and a case study from a home services company.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/home-services", label: "Home Services Processing Overview", description: "Solutions for mobile and field-based businesses." },
      { href: "/assets/case-studies/home-services-mobile", label: "Case Study: Home Services Mobile", description: "How a service company went mobile with payments." },
      { href: "/assets/0-percent/overview", label: "0% Processing Overview", description: "Offset costs on high-ticket service calls." },
    ],
  },

  "/packet/retail": {
    title: "Retail Vertical Packet",
    subtitle: "Payment Processing Resources for Retail Stores",
    description: "Resources for retail merchants processing high volumes of card-present transactions. Covers debit optimization, fast checkout, and a case study from a specialty retailer.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/retail", label: "Retail Processing Overview", description: "Solutions for high-volume retail environments." },
      { href: "/assets/case-studies/retail-fast-checkout", label: "Case Study: Fast Checkout", description: "Faster checkout and debit savings for a retail store." },
      { href: "/assets/terminal/smart-terminal", label: "Liberty Smart Terminal", description: "Contactless-ready terminal for fast retail checkout." },
    ],
  },

  "/packet/salon": {
    title: "Salon / Beauty Vertical Packet",
    subtitle: "Payment Processing Resources for Salons and Beauty Studios",
    description: "Resources for salons, spas, and beauty studios processing a high volume of low-to-mid ticket transactions with deposits and memberships.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/salon", label: "Salon Processing Overview", description: "Talking points for debit-heavy, deposit-driven ticket mixes." },
      { href: "/assets/0-percent/overview", label: "0% Processing Overview", description: "Compliant programs for service-based tickets, where eligible." },
    ],
  },

  "/packet/gym": {
    title: "Gym / Fitness Vertical Packet",
    subtitle: "Payment Processing Resources for Gyms and Fitness Studios",
    description: "Resources for gyms and fitness studios that depend on recurring membership billing and card-on-file reliability.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/gym", label: "Gym & Fitness Processing Overview", description: "Talking points for recurring billing and chargeback support." },
      { href: "/assets/0-percent/overview", label: "0% Processing Overview", description: "Compliant programs for day-pass and walk-in transactions, where eligible." },
    ],
  },

  "/packet/hotel": {
    title: "Hotel / Hospitality Vertical Packet",
    subtitle: "Payment Processing Resources for Hotels and Lodging",
    description: "Resources for hotels, inns, and short-term lodging businesses managing pre-auths, incidental holds, and higher-ticket corporate/rewards card mixes.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/hotel", label: "Hotel & Hospitality Processing Overview", description: "Talking points for pre-auths, corporate cards, and PMS integration." },
      { href: "/assets/terminal/smart-terminal", label: "Liberty Smart Terminal", description: "Terminal options for front-desk and incidental billing." },
    ],
  },

  "/packet/legal": {
    title: "Legal / Professional Services Vertical Packet",
    subtitle: "Payment Processing Resources for Law Firms and Professional Services",
    description: "Resources for law firms, CPAs, and consultants with invoice-based billing and lower transaction volume.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/legal", label: "Legal & Professional Services Processing Overview", description: "Talking points for trust accounts, invoicing, and monthly minimums." },
      { href: "/assets/one-pagers/how-statement-review-works", label: "How Statement Review Works", description: "Step-by-step breakdown of our review process." },
    ],
  },

  "/packet/general": {
    title: "General / Local Business Packet",
    subtitle: "Payment Processing Resources for Any Local Business",
    description: "Default packet for verticals without a dedicated collateral set. Covers the fundamentals of a statement review and program fit, applicable to any local business.",
    bullets: [],
    type: "packet",
    links: [
      { href: "/assets/verticals/general", label: "General & Local Business Processing Overview", description: "Universal statement-review talking points." },
      { href: "/assets/one-pagers/why-liberty", label: "Why Liberty Bancard", description: "Our approach: diagnose first, quote second." },
      { href: "/assets/one-pagers/hidden-fees-checklist", label: "Hidden Fees Checklist", description: "Common junk fees and markups we identify." },
    ],
  },
};

function getIconForCategory(name: string) {
  switch (name) {
    case "Start Here": return <BookOpen className="w-5 h-5 text-primary" />;
    case "Programs + Competitive": return <BarChart3 className="w-5 h-5 text-primary" />;
    case "Terminal": return <Monitor className="w-5 h-5 text-primary" />;
    case "Verticals": return <Store className="w-5 h-5 text-primary" />;
    case "Case Studies": return <ClipboardList className="w-5 h-5 text-primary" />;
    default: return <FolderOpen className="w-5 h-5 text-primary" />;
  }
}

function CtaSection() {
  return (
    <section className="mt-12 border-t border-border pt-10">
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <Link href="/upload-statement" data-testid="link-cta-upload">
          <Button className="gap-2">
            <Upload className="w-4 h-4" />
            Upload Statement
          </Button>
        </Link>
        <a href={CALENDAR_URL} target="_blank" rel="noopener noreferrer" data-testid="link-cta-book-call">
          <Button variant="outline" className="gap-2">
            <Calendar className="w-4 h-4" />
            Book 10-Min Call
          </Button>
        </a>
      </div>
    </section>
  );
}

function ComplianceMicroline() {
  return (
    <p
      className="text-[10px] text-muted-foreground mt-8 leading-tight"
      data-testid="text-asset-compliance"
    >
      Eligibility, underwriting, card brand rules, and applicable laws apply. No savings claims without statement review.
    </p>
  );
}

function StandardPage({ content }: { content: ContentPage }) {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold text-foreground tracking-tight" data-testid="text-asset-title">
        {content.title}
      </h1>
      <p className="mt-2 text-lg text-muted-foreground" data-testid="text-asset-subtitle">
        {content.subtitle}
      </p>

      {content.stats && content.stats.length > 0 && (
        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="asset-stats-grid">
          {content.stats.map((stat, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-3 text-center">
                <div className="text-2xl font-bold text-primary" data-testid={`text-stat-value-${i}`}>{stat.value}</div>
                <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {content.images && content.images.length > 0 && (
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="asset-image-gallery">
          {content.images.map((img, i) => (
            <div key={i} className={`${i === 0 && content.images!.length > 2 ? "md:col-span-2" : ""}`}>
              <img
                src={img.src}
                alt={img.alt}
                className="w-full rounded-md object-cover"
                data-testid={`img-asset-${i}`}
              />
              {img.caption && (
                <p className="text-xs text-muted-foreground mt-2 text-center">{img.caption}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 text-foreground/80 leading-relaxed max-w-3xl" data-testid="text-asset-description">
        {content.description}
      </p>
      {content.bullets.length > 0 && (
        <Card className="mt-8">
          <CardContent className="pt-6">
            <ul className="space-y-3">
              {content.bullets.map((bullet, i) => (
                <li key={i} className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  <span className="text-foreground/80">{bullet}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <CtaSection />
      <ComplianceMicroline />
    </>
  );
}

function CaseStudyPage({ content }: { content: ContentPage }) {
  const cs = content.caseStudy!;
  const sections = [
    { label: "Snapshot", value: cs.snapshot, icon: <FileText className="w-5 h-5 text-primary" /> },
    { label: "Before", value: cs.before, icon: <AlertCircle className="w-5 h-5 text-destructive" /> },
    { label: "What We Changed", value: cs.changed, icon: <ShieldCheck className="w-5 h-5 text-primary" /> },
    { label: "After", value: cs.after, icon: <CheckCircle2 className="w-5 h-5 text-primary" /> },
  ];

  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold text-foreground tracking-tight" data-testid="text-asset-title">
        {content.title}
      </h1>
      <p className="mt-2 text-lg text-muted-foreground" data-testid="text-asset-subtitle">
        {content.subtitle}
      </p>

      {content.images && content.images.length > 0 && (
        <div className="mt-8" data-testid="case-study-image">
          {content.images.map((img, i) => (
            <div key={i}>
              <img
                src={img.src}
                alt={img.alt}
                className="w-full rounded-md object-cover max-h-80"
                data-testid={`img-case-study-${i}`}
              />
              {img.caption && (
                <p className="text-xs text-muted-foreground mt-2 text-center">{img.caption}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {content.stats && content.stats.length > 0 && (
        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="asset-stats-grid">
          {content.stats.map((stat, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-3 text-center">
                <div className="text-2xl font-bold text-primary" data-testid={`text-stat-value-${i}`}>{stat.value}</div>
                <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-6 text-foreground/80 leading-relaxed max-w-3xl" data-testid="text-asset-description">
        {content.description}
      </p>
      <div className="mt-8 space-y-4">
        {sections.map((section) => (
          <Card key={section.label}>
            <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
              {section.icon}
              <CardTitle className="text-lg">{section.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-foreground/70 text-sm leading-relaxed">{section.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {content.stats && content.stats.length > 0 && (
        <div className="mt-10">
          <h2 className="text-xl font-semibold text-foreground mb-4">Results by the Numbers</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="asset-results-stats-grid">
            {content.stats.map((stat, i) => (
              <Card key={i}>
                <CardContent className="pt-4 pb-3 text-center">
                  <div className="text-2xl font-bold text-primary" data-testid={`text-result-stat-value-${i}`}>{stat.value}</div>
                  <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <CtaSection />
      <ComplianceMicroline />
    </>
  );
}

function PacketPage({ content }: { content: ContentPage }) {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold text-foreground tracking-tight" data-testid="text-asset-title">
        {content.title}
      </h1>
      <p className="mt-2 text-lg text-muted-foreground" data-testid="text-asset-subtitle">
        {content.subtitle}
      </p>
      <p className="mt-6 text-foreground/80 leading-relaxed max-w-3xl" data-testid="text-asset-description">
        {content.description}
      </p>
      <div className="mt-8 space-y-3">
        {content.links!.map((link) => (
          <Link key={link.href} href={link.href} data-testid={`link-packet-resource-${link.href.split("/").pop()}`}>
            <Card className="hover-elevate cursor-pointer">
              <CardContent className="flex items-center gap-4 py-4">
                <CreditCard className="w-5 h-5 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{link.label}</p>
                  <p className="text-sm text-muted-foreground">{link.description}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <CtaSection />
      <ComplianceMicroline />
    </>
  );
}

function IndexPage({ content }: { content: ContentPage }) {
  const [query, setQuery] = useState("");

  const filteredCategories = content.categories!.map((category) => ({
    ...category,
    items: category.items.filter((item) =>
      item.label.toLowerCase().includes(query.toLowerCase()) ||
      category.name.toLowerCase().includes(query.toLowerCase())
    ),
  })).filter((category) => category.items.length > 0);

  const totalItems = content.categories!.reduce((sum, c) => sum + c.items.length, 0);

  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold text-foreground tracking-tight" data-testid="text-asset-title">
        {content.title}
      </h1>
      <p className="mt-2 text-lg text-muted-foreground" data-testid="text-asset-subtitle">
        {content.subtitle}
      </p>
      <p className="mt-6 text-foreground/80 leading-relaxed max-w-3xl" data-testid="text-asset-description">
        {content.description}
      </p>

      <div className="mt-8 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <Input
          type="text"
          placeholder={`Search ${totalItems} resources…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 max-w-md"
          data-testid="input-asset-search"
        />
      </div>

      <div className="mt-8 space-y-8">
        {filteredCategories.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center" data-testid="text-no-results">
            No resources matched "<span className="font-medium">{query}</span>". Try a different search term.
          </p>
        ) : (
          filteredCategories.map((category) => (
            <div key={category.name}>
              <div className="flex items-center gap-2 mb-3">
                {getIconForCategory(category.name)}
                <h2 className="text-xl font-semibold text-foreground">{category.name}</h2>
                <span className="text-xs text-muted-foreground ml-1">({category.items.length})</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {category.items.map((item) => (
                  <Link key={item.href} href={item.href} data-testid={`link-index-${item.href.split("/").pop()}`}>
                    <Card className="hover-elevate cursor-pointer">
                      <CardContent className="flex items-center gap-3 py-3">
                        <FileText className="w-4 h-4 text-primary shrink-0" />
                        <span className="text-sm font-medium text-foreground">{item.label}</span>
                        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-auto" />
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <CtaSection />
      <ComplianceMicroline />
    </>
  );
}

function NotFoundAsset() {
  return (
    <div className="text-center py-20">
      <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
      <h1 className="text-2xl font-bold text-foreground mb-2" data-testid="text-asset-not-found">Asset Not Found</h1>
      <p className="text-muted-foreground mb-6">The page you are looking for does not exist in the asset library.</p>
      <div className="flex items-center justify-center gap-4">
        <Link href="/assets" data-testid="link-back-to-assets">
          <Button variant="outline" className="gap-2">
            <FolderOpen className="w-4 h-4" />
            Browse Asset Library
          </Button>
        </Link>
        <Link href="/" data-testid="link-back-to-home">
          <Button className="gap-2">
            Go Home
          </Button>
        </Link>
      </div>
    </div>
  );
}

export default function AssetPage() {
  const [location] = useLocation();
  const { user } = useAuth();
  const isEmployee = user?.role === "admin" || user?.role === "manager" || user?.role === "agent";

  const path = location.replace(/\/$/, "") || "/assets";
  const content = contentMap[path];

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <SEO title="Sales Asset" description="Liberty Bancard sales enablement asset for prospect education and proposal walkthroughs." path="/assets" noindex />
      <Navbar />
      <main className="flex-grow pt-28 pb-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          {isEmployee && (
            <p className="mb-4 text-sm text-muted-foreground" data-testid="link-assets-return-to-crm">
              This is the public sales library. <Link href="/dashboard/knowledge-base" className="underline underline-offset-2">Back to Resources</Link>
            </p>
          )}
          {!content && <NotFoundAsset />}
          {content?.type === "standard" && <StandardPage content={content} />}
          {content?.type === "case-study" && <CaseStudyPage content={content} />}
          {content?.type === "packet" && <PacketPage content={content} />}
          {content?.type === "index" && <IndexPage content={content} />}
        </div>
      </main>
      <Footer />
    </div>
  );
}
