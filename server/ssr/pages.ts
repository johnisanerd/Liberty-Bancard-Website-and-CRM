import { ssrHtmlShell } from "../ssrShared";
import {
  FST_TITLE_FULL,
  FST_DESCRIPTION,
  FST_KEYWORDS,
  FST_PATH,
  FST_SERVICE_NAME,
  FST_SERVICE_DESCRIPTION,
  fstFaqItems,
} from "@shared/free-smart-terminal-content";
import {
  FSR_ANCHOR_ID,
  FSR_COST,
  FSR_DISCLOSURE,
  FSR_FUNDING_NOTE,
  FSR_HANDLING,
  FSR_HEADING,
  FSR_WHAT_IT_IS,
  FSR_WHAT_TO_SUBMIT,
  FSR_WHAT_YOU_RECEIVE,
  FSR_WHO_QUALIFIES,
} from "@shared/free-statement-review-content";

const BASE_URL = "https://libertybancard.com";

function ctaSection(headline: string, sub: string): string {
  return `
  <section class="ssr-section ssr-section-dark">
    <div class="ssr-section-inner ssr-cta-section">
      <h2>${headline}</h2>
      <p>${sub}</p>
      <div class="ssr-cta-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Upload Statement — It's Free</a>
        <a href="/free-analysis" class="ssr-btn-outline">📞 Talk to an Expert</a>
      </div>
    </div>
  </section>`;
}

function getFreeStatementReviewExplainerHtml(): string {
  return `
  <section class="ssr-section" id="${FSR_ANCHOR_ID}">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">${FSR_HEADING}</h2>
      <div class="ssr-card">
        <div class="ssr-card-title">${FSR_WHAT_IT_IS.heading}</div>
        <div class="ssr-card-text">${FSR_WHAT_IT_IS.intro}</div>
        <ul>
          ${FSR_WHAT_IT_IS.parts.map((part) => `<li><strong>${part.term}</strong> — ${part.text}</li>`).join("\n          ")}
        </ul>
        <div class="ssr-card-text">${FSR_WHAT_IT_IS.outro}</div>
      </div>
      <div class="ssr-card">
        <div class="ssr-card-title">${FSR_WHAT_YOU_RECEIVE.heading}</div>
        <div class="ssr-card-text">${FSR_WHAT_YOU_RECEIVE.text}</div>
      </div>
      <div class="ssr-card">
        <div class="ssr-card-title">${FSR_COST.heading}</div>
        <div class="ssr-card-text">${FSR_COST.text}</div>
      </div>
      <div class="ssr-card">
        <div class="ssr-card-title">${FSR_WHAT_TO_SUBMIT.heading}</div>
        ${FSR_WHAT_TO_SUBMIT.paragraphs.map((paragraph) => `<div class="ssr-card-text">${paragraph}</div>`).join("\n        ")}
      </div>
      <div class="ssr-card">
        <div class="ssr-card-title">${FSR_HANDLING.heading}</div>
        <div class="ssr-card-text">${FSR_HANDLING.text}</div>
      </div>
      <div class="ssr-card">
        <div class="ssr-card-title">${FSR_WHO_QUALIFIES.heading}</div>
        <div class="ssr-card-text">${FSR_WHO_QUALIFIES.text}</div>
      </div>
      <div class="ssr-card">
        <div class="ssr-card-title">${FSR_FUNDING_NOTE.heading}</div>
        <div class="ssr-card-text">${FSR_FUNDING_NOTE.text}</div>
      </div>
      <p class="ssr-card-text">${FSR_DISCLOSURE}</p>
    </div>
  </section>`;
}

export function getUploadStatementHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Free Statement Review | Liberty Bancard",
    description: "Upload your merchant statement for a free, no-obligation analysis. See exactly what you're paying in fees and how much you could save.",
    url: `${BASE_URL}/upload-statement`,
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Upload Statement</span></div>
      <div class="ssr-hero-badge">🔒 Secure &amp; Confidential</div>
      <h1>Get a Free Merchant Statement Review</h1>
      <p class="ssr-hero-subtitle">Upload your current processing statement and we'll show you exactly what you're paying — and exactly what you could save. No pressure, no obligation.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement#form" class="ssr-btn-primary">📤 Upload My Statement Now</a>
        <a href="/savings-calculator" class="ssr-btn-outline">🧮 Try Savings Calculator</a>
      </div>
    </div>
  </div>

  ${getFreeStatementReviewExplainerHtml()}

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">What You Get With a Free Statement Review</h2>
      <p class="ssr-section-subheading">A detailed, line-item breakdown of your current processing costs — and a clear alternative.</p>
      <div class="ssr-grid-3">
        <div class="ssr-card">
          <div class="ssr-card-title">📊 Line-Item Fee Breakdown</div>
          <div class="ssr-card-text">We decode every line of your current statement: interchange, assessments, markups, and junk fees. Most merchants don't know what they're really paying.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">💰 Savings Projection</div>
          <div class="ssr-card-text">We calculate your estimated annual savings under interchange-plus pricing. Most businesses processing $20,000+/month save $2,000–$6,000/year.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">🎯 Program Recommendations</div>
          <div class="ssr-card-text">Based on your volume and business type, we recommend the best program — including 0% processing options where they apply to your situation.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">How It Works</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">1️⃣</div>
          <div class="ssr-card-title">Upload Your Statement</div>
          <div class="ssr-card-text">Securely upload your most recent 1–3 months of processing statements. PDF, image, or any format works.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">2️⃣</div>
          <div class="ssr-card-title">We Analyze It</div>
          <div class="ssr-card-text">Our team reviews your statement within 1 business day and builds your personalized savings report.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">3️⃣</div>
          <div class="ssr-card-title">Review Together</div>
          <div class="ssr-card-text">We walk you through your report on a call. No obligation — if the numbers don't make sense, we say so.</div>
        </div>
      </div>
    </div>
  </section>
  ${ctaSection("Ready to See Your Savings?", "Upload your statement now. Our team will have your analysis ready within 1 business day.")}`;

  return ssrHtmlShell({
    title: "Free Merchant Statement Review | Liberty Bancard",
    description: "Upload your merchant processing statement for a free, no-obligation analysis. See exactly what you are paying in fees and how much you could save.",
    canonical: "/upload-statement",
    keywords: "free statement review, merchant statement analysis, processing fee review, credit card processing comparison, upload merchant statement",
    schemaJsons: [schema],
    body,
  });
}

export function getFreeAnalysisHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Free Payment Processing Analysis",
    description: "Free merchant services analysis to identify savings opportunities in your current payment processing setup.",
    provider: { "@type": "Organization", name: "Liberty Bancard", url: BASE_URL },
    url: `${BASE_URL}/free-analysis`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free consultation and statement review" },
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Free Analysis</span></div>
      <div class="ssr-hero-badge">💼 Free Consultation</div>
      <h1>Free Payment Processing Analysis for Your Business</h1>
      <p class="ssr-hero-subtitle">Discover hidden fees, compare pricing models, and see how much your business could save. No cost, no pressure, no obligation.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Start Free Analysis</a>
        <a href="/savings-calculator" class="ssr-btn-outline">🧮 Quick Estimate First</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">What's Included in Your Free Analysis</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card">
          <div class="ssr-card-title">📋 Current Rate Audit</div>
          <div class="ssr-card-text">We identify your effective rate, markups above interchange, and any junk fees that inflate your costs without adding value.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">🔄 Program Comparison</div>
          <div class="ssr-card-text">Side-by-side comparison of interchange-plus, flat-rate, and 0% processing programs for your business type and volume.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">📈 Savings Forecast</div>
          <div class="ssr-card-text">12-month savings projection based on your actual transaction mix — not a generic estimate.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">💳 Equipment Review</div>
          <div class="ssr-card-text">Check whether your current terminals support the most cost-effective transaction types for your business.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">🛡️ Risk &amp; Compliance Check</div>
          <div class="ssr-card-text">Quick review of your current setup's PCI compliance posture and any avoidable risk exposures.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">🗓️ Implementation Timeline</div>
          <div class="ssr-card-text">If you decide to switch, we outline exactly what happens next — typically 3–5 business days to live processing.</div>
        </div>
      </div>
    </div>
  </section>
  ${ctaSection("Get Your Free Analysis Today", "Takes less than 5 minutes to submit. Your dedicated rep will call you within 1 business day.")}`;

  return ssrHtmlShell({
    title: "Free Payment Processing Analysis | See Your Savings | Liberty Bancard",
    description: "Get a free payment processing analysis from Liberty Bancard. Identify hidden fees, compare programs, and get a personalized savings forecast. No obligation.",
    canonical: "/free-analysis",
    keywords: "free payment processing analysis, merchant services analysis, processing fee audit, payment processing review, merchant account review",
    schemaJsons: [schema],
    body,
  });
}

export function getWhyLibertyHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    name: "Why Liberty Bancard | Transparent Merchant Services",
    description: "Learn why 5,000+ businesses trust Liberty Bancard for payment processing. PCI certified, dedicated reps, and interchange-plus pricing with no surprises.",
    url: `${BASE_URL}/why-liberty-bancard`,
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Why Liberty Bancard</span></div>
      <div class="ssr-hero-badge">🏆 Trusted by 5,000+ Businesses</div>
      <h1>Why Businesses Choose Liberty Bancard</h1>
      <p class="ssr-hero-subtitle">Transparency, dedicated support, and pricing that actually favors your business. No surprises — ever.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Get Free Statement Review</a>
        <a href="/case-studies" class="ssr-btn-outline">📖 Read Case Studies</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">The Liberty Bancard Difference</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card">
          <div class="ssr-card-title">🔍 Transparent Pricing</div>
          <div class="ssr-card-text">Interchange-plus pricing shows you the exact cost of every transaction. We don't bundle fees or hide markups.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">👤 Dedicated Account Rep</div>
          <div class="ssr-card-text">You get a real person who knows your account. Call, text, or email your rep directly — not a support queue.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">💳 0% Processing Option</div>
          <div class="ssr-card-text">Compliant cash discount and surcharging programs available where permitted. Many businesses reduce net processing to near zero.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">🏅 PCI DSS Level 1 Certified</div>
          <div class="ssr-card-text">We maintain the highest level of payment security compliance, protecting every transaction you process.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">⚡ Next-Day Funding</div>
          <div class="ssr-card-text">Qualified merchants receive deposits the next business day. Your cash flow stays healthy and predictable.*</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">📊 Free Statement Review</div>
          <div class="ssr-card-text">We analyze your current statement before you make any decisions. See your exact savings potential with no obligation.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1.5rem;max-width:48rem;margin:0 auto 3rem;" class="ssr-grid-2">
        <div class="ssr-card" style="text-align:center;">
          <div class="ssr-stat-value">10+</div>
          <div class="ssr-stat-label">Years in Payments</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div class="ssr-stat-value">5,000+</div>
          <div class="ssr-stat-label">Merchants Served</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div class="ssr-stat-value">$2B+</div>
          <div class="ssr-stat-label">Annual Volume Processed</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div class="ssr-stat-value">99.9%</div>
          <div class="ssr-stat-label">Platform Uptime</div>
        </div>
      </div>
      <h2 class="ssr-section-heading">Certifications &amp; Compliance</h2>
      <div class="ssr-grid-2" style="max-width:48rem;margin:0 auto;">
        <div class="ssr-card"><div class="ssr-card-title">🛡️ PCI DSS Level 1 Certified</div><div class="ssr-card-text">The highest level of payment card industry data security compliance for every merchant we serve.</div></div>
        <div class="ssr-card"><div class="ssr-card-title">🏦 Registered ISO/MSP</div><div class="ssr-card-text">Registered Independent Sales Organization with acquiring bank partnerships for institutional-grade processing.</div></div>
        <div class="ssr-card"><div class="ssr-card-title">📱 EMV &amp; Contactless Ready</div><div class="ssr-card-text">All terminals support chip, tap, and mobile wallets including Apple Pay, Google Pay, and Samsung Pay.</div></div>
        <div class="ssr-card"><div class="ssr-card-title">🔒 PCI P2PE Validated</div><div class="ssr-card-text">Point-to-point encryption on supported terminals reduces your PCI scope and protects cardholder data.</div></div>
      </div>
    </div>
  </section>
  ${ctaSection("Ready to Experience the Difference?", "See how Liberty Bancard compares to your current processor. Free statement review, no obligation.")}`;

  return ssrHtmlShell({
    title: "Why Liberty Bancard | Transparent Processing & Support",
    description: "Learn why 5,000+ businesses trust Liberty Bancard. PCI certified, dedicated account reps, interchange-plus pricing, and 0% processing options. Free statement review.",
    canonical: "/why-liberty-bancard",
    keywords: "why liberty bancard, merchant services provider, transparent payment processing, interchange plus pricing, dedicated merchant support",
    schemaJsons: [schema],
    body,
  });
}

export function getZeroPercentHtml(): string {
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      { "@type": "Question", name: "Is 0% credit card processing legal?", acceptedAnswer: { "@type": "Answer", text: "Compliant cash discount and surcharging programs are legal in most US states when implemented according to card brand rules. State laws vary — we verify compliance for your specific location before recommending a program." } },
      { "@type": "Question", name: "What's the difference between cash discount and surcharging?", acceptedAnswer: { "@type": "Answer", text: "A cash discount program posts a slightly higher listed price and offers a discount for cash payment. A surcharge program adds a disclosed fee to credit card transactions only. Both can effectively reduce net processing costs to near zero when implemented correctly." } },
      { "@type": "Question", name: "Will customers be upset about the fee?", acceptedAnswer: { "@type": "Answer", text: "When disclosed clearly — with proper signage, staff scripting, and receipt formatting — most customers accept the policy, especially when it's common in your industry. We provide all disclosure materials and staff training guidance." } },
      { "@type": "Question", name: "How do debit cards work with 0% processing?", acceptedAnswer: { "@type": "Answer", text: "Card brand rules prohibit surcharging debit cards. In compliant programs, debit transactions are either exempted from the fee or handled through cash discount pricing that applies to all non-cash payments. We configure your program correctly from the start." } },
    ],
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>0% Processing</span></div>
      <div class="ssr-hero-badge">💳 Compliant &amp; Card-Brand Approved</div>
      <h1>0% Credit Card Processing for Your Business</h1>
      <p class="ssr-hero-subtitle">Eliminate credit card processing fees legally with compliant cash discount and surcharging programs. Keep more of every sale.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 See If You Qualify — Free</a>
        <a href="/free-analysis" class="ssr-btn-outline">📞 Ask About 0% Programs</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">How 0% Processing Works</h2>
      <p class="ssr-section-subheading">Two compliant approaches — both reviewed and configured by our team before you go live.</p>
      <div class="ssr-grid-2" style="max-width:48rem;margin:0 auto;">
        <div class="ssr-card">
          <div class="ssr-card-title">⚖️ Cash Discount</div>
          <div class="ssr-card-text">Post a slightly higher shelf price and offer a discount for cash-paying customers. Clear signage and transparent receipts are required. Simple to operate — many retail and food service businesses use this model.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">🛡️ Compliant Surcharging</div>
          <div class="ssr-card-text">Add a disclosed fee to eligible credit card transactions where permitted by state law and card brand rules. Debit transactions are excluded. We handle registration and compliance requirements.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Is 0% Processing Right for Your Business?</h2>
      <p class="ssr-section-subheading">Good candidates typically share these characteristics:</p>
      <div class="ssr-faq-wrapper">
        <ul class="ssr-check-list">
          <li><span class="check-icon">✓</span>Customers are not highly price-sensitive about payment method</li>
          <li><span class="check-icon">✓</span>Average ticket is high enough that a small disclosure fee isn't disruptive</li>
          <li><span class="check-icon">✓</span>Business is in a state where surcharging is permitted</li>
          <li><span class="check-icon">✓</span>Staff can consistently follow a simple script at checkout</li>
          <li><span class="check-icon">✓</span>Signage and receipt messaging can be updated</li>
        </ul>
      </div>
    </div>
  </section>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Frequently Asked Questions</h2>
      <div class="ssr-faq-wrapper">
        <div class="ssr-faq-item"><div class="ssr-faq-q">Is 0% credit card processing legal?</div><div class="ssr-faq-a">Compliant cash discount and surcharging programs are legal in most US states when implemented according to card brand rules. State laws vary — we verify compliance for your specific location before recommending a program.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">What's the difference between cash discount and surcharging?</div><div class="ssr-faq-a">A cash discount program posts a slightly higher listed price and offers a discount for cash payment. A surcharge program adds a disclosed fee to credit card transactions only. Both can effectively reduce net processing costs to near zero when implemented correctly.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">Will customers be upset about the fee?</div><div class="ssr-faq-a">When disclosed clearly — with proper signage, staff scripting, and receipt formatting — most customers accept the policy, especially when it's common in your industry. We provide all disclosure materials and staff training guidance.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">How do debit cards work with 0% processing?</div><div class="ssr-faq-a">Card brand rules prohibit surcharging debit cards. In compliant programs, debit transactions are either exempted from the fee or handled through cash discount pricing. We configure your program correctly from the start.</div></div>
      </div>
    </div>
  </section>
  ${ctaSection("Ready to Go to 0%?", "Upload your statement and we'll show you whether 0% processing is the right fit for your business — and exactly how much you'd keep.")}`;

  return ssrHtmlShell({
    title: "0% Credit Card Processing | Liberty Bancard",
    description: "Eliminate credit card processing fees with compliant 0% programs. Cash discount and surcharging options reviewed and configured by Liberty Bancard experts.",
    canonical: "/0-percent-processing",
    keywords: "0 percent processing, zero percent credit card processing, cash discount program, surcharging program, eliminate processing fees, no fee processing",
    schemaJsons: [faqSchema],
    body,
  });
}

export function getCaseStudiesHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Merchant Case Studies | Liberty Bancard",
    description: "Real savings stories from Liberty Bancard merchants across restaurants, retail, healthcare, and more.",
    url: `${BASE_URL}/case-studies`,
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Case Studies</span></div>
      <div class="ssr-hero-badge">📖 Real Merchant Savings</div>
      <h1>How Liberty Bancard Saves Real Businesses Real Money</h1>
      <p class="ssr-hero-subtitle">These aren't estimates — they're actual results from merchants who compared their statements and made the switch.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Get My Statement Review</a>
        <a href="/savings-calculator" class="ssr-btn-outline">🧮 Estimate My Savings</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Merchant Savings Snapshots</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card">
          <div class="ssr-hero-badge" style="margin-bottom:0.75rem;background:#eff6ff;color:#1e3a5f;border-color:#bfdbfe;">🍽️ Restaurant — Miami, FL</div>
          <div class="ssr-stat-value">$4,800/yr</div>
          <div class="ssr-stat-label" style="margin-bottom:0.75rem;">Saved switching from Square</div>
          <div class="ssr-card-text">High-volume lunch spot processing $35,000/month. Switched from Square 2.6% flat rate to interchange-plus. Also deployed compliant surcharging for dine-in credit transactions.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-hero-badge" style="margin-bottom:0.75rem;background:#f0fdf4;color:#065f46;border-color:#bbf7d0;">🏥 Medical Practice — Fort Lauderdale</div>
          <div class="ssr-stat-value">$3,200/yr</div>
          <div class="ssr-stat-label" style="margin-bottom:0.75rem;">Saved switching from Stripe</div>
          <div class="ssr-card-text">Multi-physician practice processing $28,000/month in copays and self-pay. Stripe's 2.9% online rate was billing the practice on keyed transactions. Moved to interchange-plus with proper MCC coding.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-hero-badge" style="margin-bottom:0.75rem;background:#fef3c7;color:#92400e;border-color:#fde68a;">🏪 Retail Shop — Boca Raton</div>
          <div class="ssr-stat-value">$2,100/yr</div>
          <div class="ssr-stat-label" style="margin-bottom:0.75rem;">Saved eliminating junk fees</div>
          <div class="ssr-card-text">Boutique retail processing $18,000/month on a tiered plan. After statement review, discovered $175/month in avoidable fees. Moved to interchange-plus and deployed cash discount program.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-hero-badge" style="margin-bottom:0.75rem;background:#fdf4ff;color:#6b21a8;border-color:#e9d5ff;">💅 Salon &amp; Spa — Aventura</div>
          <div class="ssr-stat-value">$1,900/yr</div>
          <div class="ssr-stat-label" style="margin-bottom:0.75rem;">Saved with 0% processing</div>
          <div class="ssr-card-text">Full-service salon processing $15,000/month. Implemented compliant cash discount program — most service clients opted for card but appreciated transparency. Net processing cost dropped to near zero.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-hero-badge" style="margin-bottom:0.75rem;background:#fff7ed;color:#9a3412;border-color:#fed7aa;">🔧 Auto Repair — Pompano Beach</div>
          <div class="ssr-stat-value">$2,600/yr</div>
          <div class="ssr-stat-label" style="margin-bottom:0.75rem;">Saved switching from Clover</div>
          <div class="ssr-card-text">Auto shop processing $22,000/month. Clover's bundled plan was billing 2.49%+. Moved to interchange-plus and deployed surcharging on credit transactions — large average tickets made this highly effective.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-hero-badge" style="margin-bottom:0.75rem;background:#f0f9ff;color:#0c4a6e;border-color:#bae6fd;">🏗️ Construction — West Palm Beach</div>
          <div class="ssr-stat-value">$5,400/yr</div>
          <div class="ssr-stat-label" style="margin-bottom:0.75rem;">Saved with proper B2B coding</div>
          <div class="ssr-card-text">General contractor processing $45,000/month in progress payments via card. Previous processor wasn't qualifying B2B transactions for Level 2/3 interchange. Proper coding reduced rates significantly.</div>
        </div>
      </div>
    </div>
  </section>
  ${ctaSection("What Could You Save?", "Upload your statement and we'll build a personalized savings analysis — just like these merchants received before switching.")}`;

  return ssrHtmlShell({
    title: "Merchant Case Studies | Real Savings Stories | Liberty Bancard",
    description: "See how real businesses saved $1,900–$5,400/year by switching to Liberty Bancard. Case studies from restaurants, retail, healthcare, auto repair, and more.",
    canonical: "/case-studies",
    keywords: "payment processing savings, merchant savings case studies, credit card processing savings, interchange plus savings, switch payment processor",
    schemaJsons: [schema],
    body,
  });
}

export function getEstimateHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Payment Processing Cost Estimator | Liberty Bancard",
    description: "Estimate your credit card processing costs under different pricing models. See your current fees vs interchange-plus pricing.",
    url: `${BASE_URL}/estimate`,
    applicationCategory: "FinanceApplication",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Get an Estimate</span></div>
      <div class="ssr-hero-badge">🧮 Quick Cost Estimate</div>
      <h1>Estimate Your Payment Processing Costs</h1>
      <p class="ssr-hero-subtitle">Answer a few quick questions and get an instant cost comparison between your current plan and Liberty Bancard's interchange-plus pricing.</p>
      <div class="ssr-hero-buttons">
        <a href="/estimate#tool" class="ssr-btn-primary">🧮 Start Estimate Tool</a>
        <a href="/upload-statement" class="ssr-btn-outline">📤 Get Exact Analysis</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">What You'll Learn</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card">
          <div class="ssr-card-title">💰 Current Processing Cost</div>
          <div class="ssr-card-text">Estimate what you're paying today based on your pricing model and monthly volume. Most merchants are surprised how much they're spending.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">📉 Interchange-Plus Estimate</div>
          <div class="ssr-card-text">See what your costs would look like under Liberty Bancard's interchange-plus pricing — the most transparent model available.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">💵 Annual Savings Potential</div>
          <div class="ssr-card-text">Get an estimated annual savings figure. For exact numbers, upload your actual statement for a precise analysis.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner" style="text-align:center;">
      <h2 class="ssr-section-heading">Typical Savings by Business Type</h2>
      <p class="ssr-section-subheading">Based on businesses that submitted statements and switched to Liberty Bancard*</p>
      <div class="ssr-grid-3" style="max-width:56rem;margin:0 auto;">
        <div class="ssr-card"><div class="ssr-stat-value">$3,000–$6,000</div><div class="ssr-stat-label">Restaurants ($30K–$50K/mo)</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$1,500–$3,000</div><div class="ssr-stat-label">Retail ($15K–$25K/mo)</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$2,000–$4,500</div><div class="ssr-stat-label">Healthcare ($20K–$40K/mo)</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$1,200–$2,500</div><div class="ssr-stat-label">Salons &amp; Spas ($12K–$20K/mo)</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$2,500–$5,000</div><div class="ssr-stat-label">Auto Repair ($25K–$45K/mo)</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$3,500–$7,000</div><div class="ssr-stat-label">Construction ($40K+/mo)</div></div>
      </div>
      <p style="font-size:0.75rem;color:#94a3b8;margin-top:1rem;">*Estimates only. Actual savings depend on transaction mix, card types, and current pricing. Upload your statement for exact figures.</p>
    </div>
  </section>
  ${ctaSection("Get Your Exact Savings Number", "The estimate tool gives you a range. Your statement gives us the exact numbers. Upload it free — no obligation.")}`;

  return ssrHtmlShell({
    title: "Payment Processing Cost Estimator | Liberty Bancard",
    description: "Estimate your credit card processing costs and potential savings. Compare current fees vs interchange-plus pricing. Get exact numbers with a free statement review.",
    canonical: "/estimate",
    keywords: "payment processing estimate, credit card processing cost calculator, processing fee estimator, merchant services estimate, interchange plus estimate",
    schemaJsons: [schema],
    body,
  });
}

export function getSavingsCalculatorHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Savings Calculator | Liberty Bancard",
    description: "Calculate how much you could save by switching to interchange-plus payment processing with Liberty Bancard.",
    url: `${BASE_URL}/savings-calculator`,
    applicationCategory: "FinanceApplication",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Savings Calculator</span></div>
      <div class="ssr-hero-badge">💰 Free Savings Calculator</div>
      <h1>Calculate Your Payment Processing Savings</h1>
      <p class="ssr-hero-subtitle">Enter your monthly processing volume and current rate to see how much you could save by switching to Liberty Bancard's interchange-plus pricing.</p>
      <div class="ssr-hero-buttons">
        <a href="/savings-calculator#calc" class="ssr-btn-primary">💰 Open Calculator</a>
        <a href="/upload-statement" class="ssr-btn-outline">📤 Get Exact Savings Analysis</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">How the Calculator Works</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">1️⃣</div>
          <div class="ssr-card-title">Enter Your Volume</div>
          <div class="ssr-card-text">Input your monthly credit card processing volume. You can find this on your merchant statement.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">2️⃣</div>
          <div class="ssr-card-title">Select Your Pricing Model</div>
          <div class="ssr-card-text">Choose flat-rate, tiered, or interchange-plus. If you're not sure, use flat-rate for a conservative estimate.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">3️⃣</div>
          <div class="ssr-card-title">See Your Savings</div>
          <div class="ssr-card-text">Get an estimated monthly and annual savings projection based on Liberty Bancard's typical interchange-plus markup.</div>
        </div>
      </div>
    </div>
  </section>
  ${ctaSection("Ready for Your Exact Number?", "The calculator gives you a strong estimate. A free statement review gives you the precise amount — down to the dollar.")}`;

  return ssrHtmlShell({
    title: "Payment Processing Savings Calculator | Free Tool | Liberty Bancard",
    description: "Calculate how much you could save on credit card processing fees. Enter your monthly volume and current rate to get an instant savings estimate. Free tool.",
    canonical: "/savings-calculator",
    keywords: "payment processing savings calculator, credit card processing savings, merchant savings calculator, processing fee calculator, how much can I save processing",
    schemaJsons: [schema],
    body,
  });
}

export function getCompareRatesHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Compare Payment Processor Rates | Liberty Bancard",
    description: "Compare Liberty Bancard vs Square, Stripe, Clover, Toast, PayPal, Helcim, and Authorize.Net. Side-by-side pricing and feature comparisons.",
    url: `${BASE_URL}/compare-rates`,
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Compare Rates</span></div>
      <div class="ssr-hero-badge">📊 Unbiased Comparison</div>
      <h1>Compare Payment Processor Rates &amp; Features</h1>
      <p class="ssr-hero-subtitle">See how Liberty Bancard's interchange-plus pricing stacks up against the most popular payment processors. Make an informed decision.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Compare With My Statement</a>
        <a href="/savings-calculator" class="ssr-btn-outline">🧮 Quick Calculator</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Head-to-Head Comparisons</h2>
      <p class="ssr-section-subheading">Click any comparison for a detailed feature and pricing breakdown.</p>
      <div class="ssr-grid-3">
        <a href="/compare/square" class="ssr-card" style="display:block;text-decoration:none;">
          <div class="ssr-card-title">Liberty Bancard vs Square</div>
          <div class="ssr-card-text">Interchange-plus vs. flat-rate 2.6%. Most businesses save $2,000–$6,000/year. Best for brick-and-mortar retail and restaurants.</div>
          <div style="color:#0ea5e9;font-size:0.875rem;font-weight:600;margin-top:0.75rem;">View Comparison →</div>
        </a>
        <a href="/compare/stripe" class="ssr-card" style="display:block;text-decoration:none;">
          <div class="ssr-card-title">Liberty Bancard vs Stripe</div>
          <div class="ssr-card-text">Transparent interchange-plus vs. Stripe's 2.9% + $0.30. In-person rates and 0% programs available. Best for growing in-person businesses.</div>
          <div style="color:#0ea5e9;font-size:0.875rem;font-weight:600;margin-top:0.75rem;">View Comparison →</div>
        </a>
        <a href="/compare/clover" class="ssr-card" style="display:block;text-decoration:none;">
          <div class="ssr-card-title">Liberty Bancard vs Clover</div>
          <div class="ssr-card-text">Avoid Clover's bundled fees while keeping the hardware you love. Use any terminal — no captive ecosystem required.</div>
          <div style="color:#0ea5e9;font-size:0.875rem;font-weight:600;margin-top:0.75rem;">View Comparison →</div>
        </a>
        <a href="/compare/toast" class="ssr-card" style="display:block;text-decoration:none;">
          <div class="ssr-card-title">Liberty Bancard vs Toast</div>
          <div class="ssr-card-text">Restaurant-specific comparison. Toast's 2.49% vs interchange-plus. Escape proprietary hardware lock-in and save on every swipe.</div>
          <div style="color:#0ea5e9;font-size:0.875rem;font-weight:600;margin-top:0.75rem;">View Comparison →</div>
        </a>
        <a href="/compare/paypal" class="ssr-card" style="display:block;text-decoration:none;">
          <div class="ssr-card-title">Liberty Bancard vs PayPal</div>
          <div class="ssr-card-text">PayPal's 2.99% + $0.49 in-person rate vs interchange-plus. Stop risking account holds and save on every transaction.</div>
          <div style="color:#0ea5e9;font-size:0.875rem;font-weight:600;margin-top:0.75rem;">View Comparison →</div>
        </a>
        <a href="/compare/helcim" class="ssr-card" style="display:block;text-decoration:none;">
          <div class="ssr-card-title">Liberty Bancard vs Helcim</div>
          <div class="ssr-card-text">Both offer interchange-plus — see why Liberty Bancard's dedicated reps, 0% programs, and local support give businesses an edge.</div>
          <div style="color:#0ea5e9;font-size:0.875rem;font-weight:600;margin-top:0.75rem;">View Comparison →</div>
        </a>
        <a href="/compare/authorize-net" class="ssr-card" style="display:block;text-decoration:none;">
          <div class="ssr-card-title">Liberty Bancard vs Authorize.Net</div>
          <div class="ssr-card-text">Eliminate the $25/month gateway fee and bundled pricing. Get interchange-plus transparency with no separate gateway charge.</div>
          <div style="color:#0ea5e9;font-size:0.875rem;font-weight:600;margin-top:0.75rem;">View Comparison →</div>
        </a>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Pricing Model Quick Guide</h2>
      <div class="ssr-table-wrapper">
        <table class="ssr-table">
          <thead><tr><th>Pricing Model</th><th>How It Works</th><th>Who Uses It</th><th>Transparency</th></tr></thead>
          <tbody>
            <tr><td><strong>Flat-Rate</strong></td><td>Fixed % on every transaction regardless of card type</td><td>Square, Stripe, PayPal</td><td>Simple but expensive for reward cards</td></tr>
            <tr><td><strong>Tiered</strong></td><td>Transactions sorted into qualified/mid/non-qualified buckets</td><td>Traditional processors</td><td>Opaque — processor controls bucketing</td></tr>
            <tr><td><strong>Interchange-Plus</strong></td><td>Actual network cost + fixed markup disclosed on statement</td><td>Liberty Bancard, Helcim</td><td>Most transparent model available</td></tr>
            <tr><td><strong>0% / Cash Discount</strong></td><td>Customers pay a posted price; cash discount reduces the card cost</td><td>Liberty Bancard</td><td>Eliminates net cost for qualifying businesses</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
  ${ctaSection("See How You Compare", "Upload your current statement and we'll show you side-by-side how your costs compare to interchange-plus pricing.")}`;

  return ssrHtmlShell({
    title: "Compare Payment Processor Rates | Liberty Bancard",
    description: "Compare payment processing rates and features. Liberty Bancard vs Square, Stripe, Clover, Toast, PayPal, Helcim, and Authorize.Net. See who saves you more.",
    canonical: "/compare-rates",
    keywords: "compare payment processors, payment processing rates comparison, square vs stripe vs clover, best payment processor, interchange plus comparison",
    schemaJsons: [schema],
    body,
  });
}

export function getGetStartedHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Get Started with Liberty Bancard | Merchant Services",
    description: "Start accepting payments with Liberty Bancard. Simple onboarding, fast approvals, and dedicated support throughout setup.",
    url: `${BASE_URL}/get-started`,
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Get Started</span></div>
      <div class="ssr-hero-badge">🚀 Fast Approval Process</div>
      <h1>Start Accepting Payments with Liberty Bancard</h1>
      <p class="ssr-hero-subtitle">Simple onboarding, dedicated support, and transparent pricing from day one. Most businesses are live in 3–5 business days.</p>
      <div class="ssr-hero-buttons">
        <a href="/get-started#form" class="ssr-btn-primary">🚀 Start Application</a>
        <a href="/upload-statement" class="ssr-btn-outline">📤 Review My Statement First</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">How to Get Started</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">1️⃣</div>
          <div class="ssr-card-title">Submit Your Application</div>
          <div class="ssr-card-text">Fill out our short online application. Basic business info, ownership details, and processing history. Takes about 10 minutes.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">2️⃣</div>
          <div class="ssr-card-title">Underwriting &amp; Approval</div>
          <div class="ssr-card-text">Our team reviews your application and typically approves within 1–2 business days. Your dedicated rep keeps you updated throughout.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">3️⃣</div>
          <div class="ssr-card-title">Equipment &amp; Go Live</div>
          <div class="ssr-card-text">Equipment is shipped or programmed, and your rep walks you through activation. Most businesses are processing live within 3–5 business days.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">What You'll Need to Apply</h2>
      <ul class="ssr-check-list" style="max-width:36rem;margin:0 auto;">
        <li><span class="check-icon">✓</span>Business name, address, and EIN/SSN</li>
        <li><span class="check-icon">✓</span>Business bank account (for deposits)</li>
        <li><span class="check-icon">✓</span>Valid government-issued ID for all owners 25%+</li>
        <li><span class="check-icon">✓</span>3 months of processing statements (if available)</li>
        <li><span class="check-icon">✓</span>Basic business information (type, time in business)</li>
      </ul>
    </div>
  </section>
  ${ctaSection("Ready to Get Started?", "Start your application today. Your dedicated rep will reach out within 1 business day to guide you through the process.")}`;

  return ssrHtmlShell({
    title: "Get Started with Liberty Bancard | Merchant Account Application",
    description: "Apply for a merchant account with Liberty Bancard. Fast approvals, dedicated support, and transparent interchange-plus pricing. Most businesses live in 3–5 days.",
    canonical: "/get-started",
    keywords: "merchant account application, get started payment processing, merchant services application, apply merchant account, payment processor application",
    schemaJsons: [schema],
    body,
  });
}

export function getBeatSquareStripeHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Switch from Square or Stripe | Liberty Bancard",
    description: "Liberty Bancard saves businesses $2,000–$6,000/year vs Square and Stripe. See how interchange-plus beats flat-rate pricing.",
    url: `${BASE_URL}/beat-square-stripe`,
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-hero-badge">💡 Better Than Flat-Rate</div>
      <h1>Beat Square &amp; Stripe on Processing Fees</h1>
      <p class="ssr-hero-subtitle">Square charges 2.6% flat. Stripe charges 2.9%. Liberty Bancard's interchange-plus pricing typically saves businesses $2,000–$6,000/year. See how.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Get My Savings Analysis</a>
        <a href="/compare/square" class="ssr-btn-outline">📊 See Square Comparison</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Why Flat-Rate Costs You More</h2>
      <p class="ssr-section-subheading">Most card transactions settle for 1.6–1.8% at the network level. Flat-rate processors pocket the difference.</p>
      <div class="ssr-grid-2" style="max-width:48rem;margin:0 auto;">
        <div class="ssr-card">
          <div class="ssr-card-title">📊 Square &amp; Stripe Flat-Rate</div>
          <ul class="ssr-x-list">
            <li><span class="x-icon">✗</span>2.6%–2.9% on every swipe</li>
            <li><span class="x-icon">✗</span>No visibility into actual interchange costs</li>
            <li><span class="x-icon">✗</span>You subsidize high-reward-card users with your fees</li>
            <li><span class="x-icon">✗</span>No option for 0% processing</li>
          </ul>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title" style="color:#059669;">✓ Liberty Bancard Interchange-Plus</div>
          <ul class="ssr-check-list">
            <li><span class="check-icon">✓</span>Actual network cost + fixed markup on statement</li>
            <li><span class="check-icon">✓</span>Full transparency — see every fee line item</li>
            <li><span class="check-icon">✓</span>You pay less on debit and basic credit cards</li>
            <li><span class="check-icon">✓</span>Liberty Zero™ — pay $0 to process cards (where eligible)*</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner" style="text-align:center;">
      <h2 class="ssr-section-heading">Annual Savings at Common Volume Levels</h2>
      <p class="ssr-section-subheading">Switching from Square (2.6%) to interchange-plus*</p>
      <div class="ssr-grid-3" style="max-width:56rem;margin:0 auto;">
        <div class="ssr-card"><div class="ssr-stat-value">$1,440</div><div class="ssr-stat-label">At $10,000/month</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$2,880</div><div class="ssr-stat-label">At $20,000/month</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$4,320</div><div class="ssr-stat-label">At $30,000/month</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$5,760</div><div class="ssr-stat-label">At $40,000/month</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">$7,200</div><div class="ssr-stat-label">At $50,000/month</div></div>
        <div class="ssr-card"><div class="ssr-stat-value">Custom</div><div class="ssr-stat-label">Upload your statement</div></div>
      </div>
      <p style="font-size:0.75rem;color:#94a3b8;margin-top:1rem;">*Estimates assume typical consumer credit card mix and 0.5% effective interchange-plus markup. Actual savings depend on transaction mix. Upload statement for exact analysis.</p>
    </div>
  </section>
  ${ctaSection("Switch from Square or Stripe Today", "Upload your Square or Stripe statement and we'll show you your exact savings. Free, fast, no obligation.")}`;

  return ssrHtmlShell({
    title: "Beat Square & Stripe on Processing Fees | Liberty Bancard",
    description: "Save $2,000–$6,000/year by switching from Square or Stripe to Liberty Bancard interchange-plus pricing. See how flat-rate fees cost you more.",
    canonical: "/beat-square-stripe",
    keywords: "beat square pricing, beat stripe fees, square alternative, stripe alternative, interchange plus vs flat rate, switch from square, switch from stripe",
    schemaJsons: [schema],
    body,
  });
}

export function getAffiliateProgramHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Affiliate Program | Earn Residual Income | Liberty Bancard",
    description: "Refer merchants to Liberty Bancard and earn ongoing residual income. Competitive commissions, real-time tracking, and dedicated affiliate support.",
    url: `${BASE_URL}/affiliate`,
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Affiliate Program</span></div>
      <div class="ssr-hero-badge">💼 Residual Income Opportunity</div>
      <h1>Earn Residual Income Referring Merchants</h1>
      <p class="ssr-hero-subtitle">Refer businesses to Liberty Bancard and earn ongoing commissions as long as they process. Real-time tracking, competitive payouts, and dedicated support.</p>
      <div class="ssr-hero-buttons">
        <a href="/affiliate#signup" class="ssr-btn-primary">💼 Join the Affiliate Program</a>
        <a href="/free-analysis" class="ssr-btn-outline">📞 Talk to Our Team</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">How the Affiliate Program Works</h2>
      <div class="ssr-grid-3">
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">1️⃣</div>
          <div class="ssr-card-title">Sign Up Free</div>
          <div class="ssr-card-text">Create your affiliate account and get a unique referral code and tracking link. No cost to join.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">2️⃣</div>
          <div class="ssr-card-title">Refer Merchants</div>
          <div class="ssr-card-text">Share your link with businesses that accept credit cards. Restaurants, retail, healthcare, service businesses — any merchant qualifies.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">3️⃣</div>
          <div class="ssr-card-title">Earn Ongoing Residuals</div>
          <div class="ssr-card-text">Earn a commission on every merchant's monthly processing volume — for as long as they're a Liberty Bancard customer.</div>
        </div>
      </div>
    </div>
  </section>
  ${ctaSection("Start Earning Today", "Join the Liberty Bancard affiliate program. Free to join, competitive commissions, real-time reporting.")}`;

  return ssrHtmlShell({
    title: "Affiliate Program | Earn Residuals | Liberty Bancard",
    description: "Join the Liberty Bancard affiliate program. Earn ongoing residual income for every merchant you refer. Free to join, competitive commissions, real-time tracking.",
    canonical: "/affiliate",
    keywords: "payment processing affiliate program, merchant services affiliate, residual income payments, refer merchant services, ISO agent program",
    schemaJsons: [schema],
    body,
  });
}

export function getTestimonialsHtml(): string {
  const videoObjectSchema = (name: string, desc: string, savings: string) => ({
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: `${name} — Merchant Testimonial | Liberty Bancard`,
    description: desc,
    thumbnailUrl: `${BASE_URL}/favicon.png`,
    uploadDate: "2025-01-15",
    duration: "PT2M30S",
    publisher: { "@type": "Organization", name: "Liberty Bancard", logo: { "@type": "ImageObject", url: `${BASE_URL}/favicon.png` } },
  });
  const reviewSchema = (name: string, business: string, desc: string) => ({
    "@context": "https://schema.org",
    "@type": "Review",
    reviewBody: desc,
    author: { "@type": "Person", name, jobTitle: business },
    itemReviewed: { "@type": "Organization", name: "Liberty Bancard", url: BASE_URL },
    reviewRating: { "@type": "Rating", ratingValue: "5", bestRating: "5" },
  });
  const schemas = [
    videoObjectSchema("Maria R.", "Our processing cost dropped to nearly zero after switching.", "$4,200"),
    videoObjectSchema("Tony M.", "They found $127 a month in fees I never agreed to.", "$2,900"),
    videoObjectSchema("David K.", "The savings were immediate once we saw the real interchange cost.", "$3,800"),
    reviewSchema("Maria R.", "Full-Service Restaurant", "Our processing cost dropped to nearly zero after switching to Liberty Bancard's cash discount program."),
    reviewSchema("Tony M.", "Auto Repair Shop Owner", "They found $127 a month in fees I never agreed to. Liberty Bancard cleaned everything up."),
    reviewSchema("David K.", "Retail Store Owner", "The savings were immediate once we saw the real interchange cost. Switching from Stripe was seamless."),
  ];
  const testimonialCards = [
    { name: "Maria R.", business: "Full-Service Restaurant", city: "South Miami, FL", quote: "Our processing cost dropped to nearly zero after switching to Liberty Bancard's cash discount program. That freed up cash we put right back into our kitchen.", savings: "$4,200/year saved", industry: "Restaurant" },
    { name: "Tony M.", business: "Auto Repair Shop", city: "Broward County, FL", quote: "I was on tiered pricing and didn't realize half my transactions were at non-qualified rates. Liberty Bancard cleaned everything up and I'm saving almost $250 a month.", savings: "$2,900/year saved", industry: "Auto Repair" },
    { name: "David K.", business: "Multi-Location Retail", city: "Boca Raton, FL", quote: "Stripe was easy to set up, but we had no idea how much we were overpaying. Liberty Bancard showed us our actual interchange costs and the markup we were paying on top.", savings: "$3,800/year saved", industry: "Retail" },
    { name: "Dr. Sarah L.", business: "Medical Practice", city: "Tampa, FL", quote: "Our bank had us on tiered pricing for years. The Level 2 processing alone saved us a significant amount on commercial insurance card payments.", savings: "$6,100/year saved", industry: "Healthcare" },
    { name: "James W.", business: "HVAC Contractor", city: "Palm Beach County, FL", quote: "Liberty Bancard set me up with a mobile reader and cash discount program. Now I process everything through one system and my processing cost is basically zero.", savings: "$1,800/year saved", industry: "Home Services" },
    { name: "Rachel T.", business: "Online Specialty Retailer", city: "Remote / Online", quote: "We thought Shopify Payments was our only option. Liberty Bancard integrated a gateway and our costs dropped by over $5,000 a year. The integration was seamless.", savings: "$5,400/year saved", industry: "E-Commerce" },
  ].map(t => `
    <div class="ssr-card" style="display:flex;flex-direction:column;">
      <div style="background:linear-gradient(135deg,#1e3a5f 0%,#1a5276 100%);border-radius:8px;padding:2.5rem 1.5rem;text-align:center;margin-bottom:1rem;">
        <div style="font-size:2.5rem;font-weight:700;color:#38bdf8;">${t.savings}</div>
        <div style="font-size:0.75rem;color:rgba(255,255,255,0.7);margin-top:0.25rem;text-transform:uppercase;letter-spacing:0.05em;">Video coming soon</div>
      </div>
      <div style="display:flex;gap:0.25rem;margin-bottom:0.75rem;">★★★★★</div>
      <p style="font-style:italic;font-size:0.9rem;color:#374151;flex-grow:1;line-height:1.6;">"${t.quote}"</p>
      <div style="border-top:1px solid #e5e7eb;padding-top:0.75rem;margin-top:1rem;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:0.875rem;font-weight:600;">${t.name}</div>
          <div style="font-size:0.75rem;color:#6b7280;">${t.business} · ${t.city}</div>
        </div>
        <span style="font-size:0.7rem;background:#f1f5f9;color:#64748b;padding:0.2rem 0.6rem;border-radius:20px;">${t.industry}</span>
      </div>
    </div>`).join("");

  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Testimonials</span></div>
      <div class="ssr-hero-badge">🎬 Merchant Stories</div>
      <h1>Real Merchants. Real Numbers.</h1>
      <p class="ssr-hero-subtitle">Watch real business owners share their payment processing transformation — specific savings, before-and-after numbers, and what switching to Liberty Bancard actually meant for their bottom line.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Get Your Free Analysis</a>
        <a href="/testimonials/submit" class="ssr-btn-outline">🎥 Share Your Story</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Merchant Video Testimonials</h2>
      <p class="ssr-section-subheading">Filter by industry or browse all. Every merchant below started with a free statement review.</p>
      <div class="ssr-grid-3" style="gap:1.5rem;">
        ${testimonialCards}
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner" style="text-align:center;max-width:700px;margin:0 auto;">
      <h2>Want to Share Your Story?</h2>
      <p>If you're a Liberty Bancard merchant with a success story to tell, we'd love to feature you. Submit your video or write a few lines — we handle the rest.</p>
      <div class="ssr-cta-buttons" style="margin-top:1.5rem;">
        <a href="/testimonials/submit" class="ssr-btn-primary">🎥 Submit Your Story</a>
        <a href="/case-studies" class="ssr-btn-outline">📖 Read Full Case Studies</a>
      </div>
    </div>
  </section>

  ${ctaSection("Your Statement Tells the Truth. Let's Read It Together.", "Every merchant on this page started with a free statement review. Upload yours and see your real numbers — same day.")}`;

  return ssrHtmlShell({
    title: "Merchant Video Testimonials — Real Results | Liberty Bancard",
    description: "Watch merchant testimonials from restaurant owners, retailers, and healthcare practices who saved thousands switching to Liberty Bancard. Filter by industry.",
    canonical: "/testimonials",
    keywords: "merchant testimonials, payment processing reviews, Liberty Bancard reviews, merchant video testimonials, credit card processing success stories",
    schemaJsons: schemas,
    body,
  });
}

export function getTestimonialsSubmitHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Submit Your Merchant Story | Liberty Bancard",
    description: "Share your payment processing success story with Liberty Bancard. Submit a video link or written testimonial and we'll feature your business on our merchant testimonials page.",
    url: `${BASE_URL}/testimonials/submit`,
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: BASE_URL },
        { "@type": "ListItem", position: 2, name: "Testimonials", item: `${BASE_URL}/testimonials` },
        { "@type": "ListItem", position: 3, name: "Submit Your Story", item: `${BASE_URL}/testimonials/submit` },
      ],
    },
  };

  const body = `
  <div class="ssr-hero" style="background:linear-gradient(135deg,#1e3a5f 0%,#1a5276 100%);padding:5rem 1.5rem 3rem;">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb" style="color:rgba(255,255,255,0.7);">
        <a href="/" style="color:rgba(255,255,255,0.7);">Home</a><span>/</span>
        <a href="/testimonials" style="color:rgba(255,255,255,0.7);">Testimonials</a><span>/</span>
        <span style="color:#fff;">Submit Your Story</span>
      </div>
      <div class="ssr-hero-badge">🎬 Merchant Stories</div>
      <h1 style="color:#fff;">Submit Your Story</h1>
      <p class="ssr-hero-subtitle" style="color:rgba(255,255,255,0.85);">We'd love to feature you on our testimonials page. Share what you were paying, what changed, and what the savings meant for your business.</p>
    </div>
  </div>

  <section class="ssr-section">
    <div class="ssr-section-inner" style="max-width:720px;margin:0 auto;">
      <div class="ssr-card" style="padding:2.5rem;">
        <h2 style="font-size:1.25rem;font-weight:700;margin-bottom:1.5rem;color:#1e293b;">Your Information</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;">
          <div>
            <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Your Name *</label>
            <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.625rem 0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;">First and Last</div>
          </div>
          <div>
            <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Business Name *</label>
            <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.625rem 0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;">Your Business</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem;">
          <div>
            <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Email *</label>
            <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.625rem 0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;">you@example.com</div>
          </div>
          <div>
            <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Phone (optional)</label>
            <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.625rem 0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;">(555) 000-0000</div>
          </div>
        </div>

        <h2 style="font-size:1.25rem;font-weight:700;margin-bottom:1.5rem;margin-top:2rem;color:#1e293b;border-top:1px solid #f1f5f9;padding-top:1.5rem;">Your Story</h2>
        <div style="margin-bottom:1rem;">
          <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Industry *</label>
          <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.625rem 0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;">Select your industry...</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;">
          <div>
            <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Approximate Annual Savings (optional)</label>
            <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.625rem 0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;">$0</div>
          </div>
          <div>
            <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Video Link (optional)</label>
            <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.625rem 0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;">https://youtube.com/...</div>
          </div>
        </div>
        <div style="margin-bottom:1.5rem;">
          <label style="font-size:0.875rem;font-weight:600;display:block;margin-bottom:0.4rem;">Your Story *</label>
          <div style="border:1px solid #e2e8f0;border-radius:6px;padding:0.875rem;background:#f8fafc;color:#94a3b8;font-size:0.875rem;height:120px;">Tell us what you were paying before, what changed after switching, and what the savings meant for your business...</div>
        </div>
        <p style="font-size:0.75rem;color:#64748b;margin-bottom:1rem;">By submitting, you agree that Liberty Bancard may feature your story (with your permission) on our website and marketing materials.</p>
        <a href="/testimonials/submit" class="ssr-btn-primary" style="display:inline-block;width:100%;text-align:center;">Submit My Story →</a>
      </div>
      <div style="text-align:center;margin-top:1.5rem;">
        <a href="/testimonials" style="font-size:0.875rem;color:#64748b;">← Back to all testimonials</a>
      </div>
    </div>
  </section>`;

  return ssrHtmlShell({
    title: "Submit Your Merchant Story | Liberty Bancard",
    description: "Share your payment processing success story with Liberty Bancard. Submit a testimonial and we will feature your business on our merchant testimonials page.",
    canonical: "/testimonials/submit",
    keywords: "merchant testimonial submission, share payment processing story, Liberty Bancard merchant review",
    schemaJsons: [schema],
    body,
  });
}

export function getIntegrationsHtml(): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Software Integrations & Compatibility | Liberty Bancard",
    description: "See which POS systems, accounting software, eCommerce platforms, and business tools Liberty Bancard works with. Keep your existing software, just pay less.",
    url: `${BASE_URL}/integrations`,
    about: {
      "@type": "Service",
      name: "Payment Processing Integrations",
      provider: { "@type": "Organization", name: "Liberty Bancard" },
    },
  };

  const categories = [
    {
      name: "POS Systems",
      items: [
        { name: "Clover POS", badge: "Direct Provider", desc: "Liberty Bancard is a direct Clover provider. We program and support Clover terminals, mini systems, and the full Station Duo with our own pricing, not Clover's published rates.", hardware: "Clover Flex 3, Clover Mini 3, Clover Station Duo" },
        { name: "Dejavoo Terminals", badge: "Recommended", desc: "Dejavoo countertop and wireless terminals work natively with Liberty's programs, including cash discount and tip adjust.", hardware: "Dejavoo QD2, QD4, Z11" },
        { name: "PAX Terminals", badge: "", desc: "PAX A920 and A35 smart terminals integrate cleanly with Liberty's interchange-plus pricing. Popular for retail and multi-lane environments.", hardware: "PAX A920, PAX A35" },
        { name: "Toast POS", badge: "", desc: "Liberty Bancard integrates with Toast-compatible payment flows. Restaurants can route through our interchange-plus gateway while keeping the Toast interface.", hardware: "Toast hardware (via gateway)" },
        { name: "Square (Migration)", badge: "Switching Guide", desc: "Switching from Square? We handle the transition. Most Square merchants save significantly on interchange-plus pricing.", hardware: "Your existing hardware or new terminal" },
      ],
    },
    {
      name: "Accounting",
      items: [
        { name: "QuickBooks", badge: "", desc: "Liberty Bancard transaction data exports cleanly into QuickBooks. Monthly statements include all the fields your bookkeeper needs for reconciliation.", hardware: "No hardware required" },
        { name: "Xero", badge: "", desc: "Xero users can reconcile Liberty Bancard batch settlements easily. Our interchange-plus statements break down every cost line-by-line.", hardware: "No hardware required" },
        { name: "Wave Accounting", badge: "", desc: "Wave-connected businesses can import Liberty Bancard transaction data and match settlements to deposits with clear reporting.", hardware: "No hardware required" },
      ],
    },
    {
      name: "eCommerce",
      items: [
        { name: "Shopify", badge: "Popular", desc: "We integrate with Shopify via Authorize.net and NMI gateways, allowing merchants to bypass Shopify Payments fees while keeping their storefront untouched.", hardware: "Authorize.net or NMI gateway" },
        { name: "WooCommerce", badge: "", desc: "WooCommerce stores connect through standard payment gateway plugins. Authorize.net and NMI are both supported.", hardware: "Authorize.net or NMI gateway" },
        { name: "Authorize.net", badge: "Primary Gateway", desc: "Authorize.net is Liberty Bancard's primary e-commerce gateway. It supports recurring billing, customer vaults, and advanced fraud detection.", hardware: "Software gateway (no hardware)" },
      ],
    },
    {
      name: "Practice Management",
      items: [
        { name: "Mindbody", badge: "", desc: "Mindbody users in fitness, yoga, and wellness can connect Liberty Bancard's payment processing to reduce per-transaction costs.", hardware: "Compatible card readers via gateway" },
        { name: "Jane App", badge: "", desc: "Jane App is widely used by physical therapists and chiropractors. Liberty Bancard can process payments outside Jane's native billing for lower interchange costs.", hardware: "Dejavoo or PAX terminal" },
        { name: "DrChrono", badge: "", desc: "Medical practices using DrChrono EHR can pair Liberty Bancard terminals for front-desk card collection while keeping their clinical workflow.", hardware: "Ingenico or Dejavoo countertop" },
      ],
    },
    {
      name: "Scheduling",
      items: [
        { name: "Acuity Scheduling", badge: "", desc: "Acuity-based businesses can use Liberty Bancard's gateway integrations to collect payments at checkout or for deposits.", hardware: "Software gateway" },
        { name: "Calendly", badge: "", desc: "Service businesses using Calendly can combine Liberty Bancard's payment infrastructure for payment collection with their scheduling workflow.", hardware: "Software gateway" },
        { name: "Vagaro", badge: "", desc: "Salons, spas, and fitness studios on Vagaro can explore Liberty Bancard's payment processing as a lower-cost alternative.", hardware: "Compatible card readers" },
      ],
    },
    {
      name: "CRM",
      items: [
        { name: "Salesforce", badge: "", desc: "Enterprise merchants can integrate Liberty Bancard transaction data into Salesforce via standard API exports.", hardware: "No hardware required" },
        { name: "HubSpot", badge: "", desc: "Liberty Bancard's back-office data can connect to HubSpot for deal tracking, renewal management, and merchant lifecycle automation.", hardware: "No hardware required" },
        { name: "Zoho CRM", badge: "", desc: "Zoho CRM users can sync Liberty Bancard merchant data and transaction summaries for account management and reporting.", hardware: "No hardware required" },
      ],
    },
  ];

  const categoryHtml = categories.map(cat => `
    <div style="margin-bottom:3rem;">
      <h2 style="font-size:1.5rem;font-weight:700;margin-bottom:1.25rem;color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:0.5rem;">${cat.name}</h2>
      <div class="ssr-grid-3" style="gap:1.25rem;">
        ${cat.items.map(item => `
          <div class="ssr-card">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.75rem;">
              <div class="ssr-card-title" style="margin:0;">${item.name}</div>
              ${item.badge ? `<span style="font-size:0.65rem;background:#eff6ff;color:#3b82f6;padding:0.15rem 0.5rem;border-radius:20px;font-weight:600;white-space:nowrap;">${item.badge}</span>` : ""}
            </div>
            <div class="ssr-card-text" style="margin-bottom:0.75rem;">${item.desc}</div>
            <div style="font-size:0.75rem;color:#059669;display:flex;align-items:flex-start;gap:0.4rem;">
              <span>✓</span><span><strong>Hardware:</strong> ${item.hardware}</span>
            </div>
          </div>`).join("")}
      </div>
    </div>`).join("");

  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Integrations</span></div>
      <div class="ssr-hero-badge">🔌 Software Compatibility</div>
      <h1>Works With Your Existing Software</h1>
      <p class="ssr-hero-subtitle">Unlike Square, Clover, and Toast — which lock you into their ecosystem — Liberty Bancard connects with the platforms you already use. Keep your POS, your accounting software, your booking tool. Just pay less.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Get My Free Analysis</a>
        <a href="#integrations-list" class="ssr-btn-outline">Browse Integrations →</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <div class="ssr-grid-3" style="margin-bottom:2rem;">
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;font-weight:700;color:#1d4ed8;">20+</div>
          <div style="font-size:0.875rem;font-weight:600;">Compatible Platforms</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;font-weight:700;color:#1d4ed8;">6</div>
          <div style="font-size:0.875rem;font-weight:600;">Integration Categories</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2rem;font-weight:700;color:#1d4ed8;">0</div>
          <div style="font-size:0.875rem;font-weight:600;">Lock-In Contracts</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section" id="integrations-list">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Integration Directory</h2>
      <p class="ssr-section-subheading">Organized by category. Don't see your software? Ask us about compatibility during your free statement review.</p>
      ${categoryHtml}
    </div>
  </section>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">No Ecosystem Lock-In</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;max-width:900px;margin:0 auto;">
        <div class="ssr-card" style="border:2px solid #fca5a5;">
          <div class="ssr-card-title" style="color:#dc2626;">Square / Clover / Toast Lock You In</div>
          <ul style="margin:0;padding-left:1.25rem;font-size:0.875rem;color:#6b7280;line-height:2;">
            <li>Must use their payment processor</li>
            <li>Hardware only works on their network</li>
            <li>Rate changes buried in terms</li>
            <li>Switching means replacing all hardware</li>
          </ul>
        </div>
        <div class="ssr-card" style="border:2px solid #86efac;">
          <div class="ssr-card-title" style="color:#16a34a;">Liberty Bancard Connects With What You Have</div>
          <ul style="margin:0;padding-left:1.25rem;font-size:0.875rem;color:#6b7280;line-height:2;">
            <li>Works with Clover, Toast, PAX, and more</li>
            <li>Keep your POS or upgrade on your terms</li>
            <li>Transparent interchange-plus pricing</li>
            <li>Switch without replacing existing software</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  ${ctaSection("Check Compatibility With Your Software", "Tell us what you use during your free statement review. We'll confirm compatibility before you switch anything.")}`;

  return ssrHtmlShell({
    title: "Software Integrations & Compatibility | Liberty Bancard",
    description: "Liberty Bancard works with Clover, Toast, QuickBooks, Shopify, Mindbody, Acuity, and 20+ more platforms. Keep your software, lower your processing costs.",
    canonical: "/integrations",
    keywords: "payment processing integrations, POS integrations, QuickBooks payment processing, Shopify payment processor, Clover payment processing, merchant software compatibility",
    schemaJsons: [schema],
    body,
  });
}

export function getFaqHtml(): string {
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      { "@type": "Question", name: "What is interchange-plus pricing?", acceptedAnswer: { "@type": "Answer", text: "Interchange-plus pricing passes the actual network cost (interchange) directly to you, plus a fixed markup that Liberty Bancard discloses on every statement. It's the most transparent pricing model available and typically saves businesses 0.5%–1.0% over flat-rate pricing." } },
      { "@type": "Question", name: "How long does merchant account approval take?", acceptedAnswer: { "@type": "Answer", text: "Most applications are approved within 1–2 business days. After approval, equipment setup and go-live typically take 3–5 business days total." } },
      { "@type": "Question", name: "Is there a contract or early termination fee?", acceptedAnswer: { "@type": "Answer", text: "Contract terms and any applicable early termination fees are clearly outlined before you sign anything. We believe in transparency — you see all terms before committing." } },
      { "@type": "Question", name: "What is 0% processing?", acceptedAnswer: { "@type": "Answer", text: "0% processing refers to compliant cash discount and surcharging programs that effectively reduce your net processing cost to near zero. Available where permitted by state law and card brand rules." } },
      { "@type": "Question", name: "How does a free statement review work?", acceptedAnswer: { "@type": "Answer", text: "Upload your current processing statement and our team analyzes every line item within 1 business day. You receive a detailed report showing your current effective rate, hidden fees, and projected savings under interchange-plus pricing — with no obligation to switch." } },
      { "@type": "Question", name: "What payment types does Liberty Bancard support?", acceptedAnswer: { "@type": "Answer", text: "All major credit and debit cards (Visa, Mastercard, Discover, American Express), contactless payments (NFC/tap), mobile wallets (Apple Pay, Google Pay, Samsung Pay), and EMV chip transactions. ACH/bank transfer available for select programs." } },
    ],
  };
  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>FAQ</span></div>
      <div class="ssr-hero-badge">❓ Common Questions</div>
      <h1>Frequently Asked Questions</h1>
      <p class="ssr-hero-subtitle">Everything you need to know about merchant services, pricing, and working with Liberty Bancard.</p>
    </div>
  </div>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <div class="ssr-faq-wrapper">
        <div class="ssr-faq-item"><div class="ssr-faq-q">What is interchange-plus pricing?</div><div class="ssr-faq-a">Interchange-plus pricing passes the actual network cost (interchange) directly to you, plus a fixed markup disclosed on every statement. It's the most transparent pricing model and typically saves businesses 0.5%–1.0% over flat-rate pricing.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">How long does merchant account approval take?</div><div class="ssr-faq-a">Most applications are approved within 1–2 business days. After approval, equipment setup and go-live typically take 3–5 business days total.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">Is there a contract or early termination fee?</div><div class="ssr-faq-a">Contract terms and any applicable early termination fees are clearly outlined before you sign anything. We believe in transparency — you see all terms before committing.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">What is 0% processing?</div><div class="ssr-faq-a">0% processing refers to compliant cash discount and surcharging programs that effectively reduce your net processing cost to near zero. Available where permitted by state law and card brand rules.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">How does a free statement review work?</div><div class="ssr-faq-a">Upload your current processing statement and our team analyzes every line item within 1 business day. You receive a detailed savings report with no obligation to switch.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">What payment types does Liberty Bancard support?</div><div class="ssr-faq-a">All major credit and debit cards, contactless (NFC/tap), mobile wallets (Apple Pay, Google Pay, Samsung Pay), and EMV chip transactions. ACH available for select programs.</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">How fast will I receive my deposits?</div><div class="ssr-faq-a">Qualified merchants receive next-day funding. Actual timing depends on cutoff times, bank schedules, and risk review. Your rep will outline your specific funding timeline during onboarding.*</div></div>
        <div class="ssr-faq-item"><div class="ssr-faq-q">Do I need to buy new equipment?</div><div class="ssr-faq-a">Not necessarily. In many cases your existing equipment can be reprogrammed. If you need new equipment, we offer purchase, lease, and free placement options depending on your program.</div></div>
      </div>
    </div>
  </section>
  ${ctaSection("Still Have Questions?", "Your dedicated rep can answer any question about pricing, programs, or the switch process. No obligation.")}`;

  return ssrHtmlShell({
    title: "FAQ | Payment Processing Questions Answered | Liberty Bancard",
    description: "Answers to common questions about merchant services, interchange-plus pricing, 0% processing, statement reviews, and working with Liberty Bancard.",
    canonical: "/faq",
    keywords: "merchant services FAQ, payment processing questions, interchange plus explained, merchant account FAQ, credit card processing FAQ",
    schemaJsons: [faqSchema],
    body,
  });
}

export function getFreeAnalysisGuaranteedHtml(): string {
  const faqItems = [
    { q: "What exactly is the $50 guarantee?", a: "If we review your statement and cannot identify at least one verifiable savings opportunity, we'll send you a $50 Amazon gift card — no questions asked. We've reviewed 3,200+ statements and have only paid out a handful of gift cards. Most merchants save significantly more." },
    { q: "Is there any obligation to switch processors?", a: "None. You get the full written analysis and benchmark report regardless of what you decide. We show you the numbers — you decide what to do with them. We earn your business by proving value, not by locking you in." },
    { q: "Do I need to schedule a sales call?", a: "No sales call required. Upload your statement, we analyze it, and we send you the written report. If you want to talk through the numbers, we're available — but it's never a requirement." },
    { q: "What information do you need from my statement?", a: "We only need the fee and volume totals — not your merchant account number or banking info. You can redact any sensitive numbers before uploading. A PDF or photo of your statement works perfectly." },
    { q: "How long does the analysis take?", a: "We deliver your written savings summary within 24 business hours. Most analyses are completed the same day during business hours (Monday–Friday, 9am–6pm ET)." },
  ];

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  const serviceSchema = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Free Merchant Statement Analysis — Guaranteed Savings",
    description: "Upload your merchant processing statement and we'll find your hidden fees, benchmark you against 3,200+ statements, and show you exactly what you should be paying. If we can't find you savings, we send you a $50 gift card.",
    provider: { "@type": "Organization", name: "Liberty Bancard", url: BASE_URL },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free statement analysis — $50 gift card guarantee if no savings found" },
  };

  const faqHtml = faqItems
    .map(
      (item) => `
    <div class="ssr-faq-item">
      <div class="ssr-faq-q">✅ ${item.q}</div>
      <div class="ssr-faq-a">${item.a}</div>
    </div>`
    )
    .join("");

  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Guarantee Analysis</span></div>
      <div class="ssr-hero-badge">🎁 100% Risk-Free Guarantee</div>
      <h1>If We Can't Save You Money, We'll Pay You $50</h1>
      <p class="ssr-hero-subtitle">Upload your processing statement and we'll find your hidden fees, benchmark you against 3,200+ real merchant statements, and deliver a written savings report within 24 hours. No sales call required. No obligation.</p>
      <div class="ssr-hero-buttons">
        <a href="/upload-statement" class="ssr-btn-primary">📤 Get My Free Analysis</a>
        <a href="tel:9542668214" class="ssr-btn-outline">📞 Call 954-266-8214</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <div style="max-width:48rem;margin:0 auto;border:2px solid #10b981;border-radius:0.75rem;background:#f0fdf4;padding:2rem;">
        <div style="display:flex;align-items:flex-start;gap:1.25rem;">
          <div style="width:3.5rem;height:3.5rem;border-radius:50%;background:#10b981;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1.5rem;">🎁</div>
          <div>
            <h2 style="font-family:'Outfit',system-ui,sans-serif;font-size:1.25rem;font-weight:700;color:#0f172a;margin-bottom:0.5rem;">Our Savings Guarantee</h2>
            <p style="font-size:0.875rem;color:#475569;line-height:1.7;margin-bottom:1rem;">We've reviewed over 3,200 merchant statements. Every single one had at least one identifiable savings opportunity. But if we review yours and genuinely cannot find a way to save you money, we'll send you a <strong>$50 Amazon gift card</strong> — just for your time.</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
              <div style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;color:#0f172a;">✅ Find savings in 24 hours or $50 gift card</div>
              <div style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;color:#0f172a;">✅ No sales call required</div>
              <div style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;color:#0f172a;">✅ No obligation to switch</div>
              <div style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;color:#0f172a;">✅ No credit card needed</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section ssr-section-dark">
    <div class="ssr-section-inner" style="text-align:center;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:2rem;max-width:36rem;margin:0 auto;">
        <div><div class="ssr-stat-value" style="color:#34d399;font-size:2.5rem;">3,200+</div><div class="ssr-stat-label" style="color:rgba(255,255,255,0.65);">Statements Reviewed</div></div>
        <div><div class="ssr-stat-value" style="color:#34d399;font-size:2.5rem;">$2,847</div><div class="ssr-stat-label" style="color:rgba(255,255,255,0.65);">Avg. Monthly Savings</div></div>
        <div><div class="ssr-stat-value" style="color:#34d399;font-size:2.5rem;">4.9/5</div><div class="ssr-stat-label" style="color:rgba(255,255,255,0.65);">Merchant Rating</div></div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">What You Get</h2>
      <p class="ssr-section-subheading">Not a vague consultation — a real deliverable you keep, regardless of what you decide.</p>
      <div class="ssr-grid-3">
        <div class="ssr-card">
          <div class="ssr-card-title">📋 Full Statement Breakdown in Plain English</div>
          <div class="ssr-card-text">We decode every line: interchange costs, processor markup, assessment fees, and any junk fees you're being charged. Written so your accountant can read it.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">📊 Benchmark Against 3,200+ Statements</div>
          <div class="ssr-card-text">We compare your effective rate and fee structure against businesses in your industry and volume tier. See exactly where you stand versus the best-in-class merchants in your category.</div>
        </div>
        <div class="ssr-card">
          <div class="ssr-card-title">📈 Written Savings Summary You Can Share</div>
          <div class="ssr-card-text">A clear, one-page savings summary with your current rate, your target rate, and estimated annual savings — formatted so you can share with your accountant, business partner, or board.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">How It Works</h2>
      <p class="ssr-section-subheading">Three steps. Under 5 minutes on your end.</p>
      <div class="ssr-grid-3">
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2.5rem;margin-bottom:0.75rem;">1️⃣</div>
          <div class="ssr-card-title">Upload Your Statement</div>
          <div class="ssr-card-text">Securely upload your most recent processing statement — PDF or photo. Redact account numbers if you prefer. We only need the fee and volume totals.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2.5rem;margin-bottom:0.75rem;">2️⃣</div>
          <div class="ssr-card-title">We Analyze in 24 Hours</div>
          <div class="ssr-card-text">Our team reviews every line item, benchmarks your costs against industry peers, and builds your personalized written savings report.</div>
        </div>
        <div class="ssr-card" style="text-align:center;">
          <div style="font-size:2.5rem;margin-bottom:0.75rem;">3️⃣</div>
          <div class="ssr-card-title">Receive Your Report</div>
          <div class="ssr-card-text">You receive a written savings summary via email — with your current rate, your target rate, and estimated annual savings. No strings attached.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Industry Standards We Uphold</h2>
      <div class="ssr-grid-2" style="max-width:40rem;margin:0 auto;">
        <div class="ssr-card" style="text-align:center;"><div style="font-size:1.5rem;margin-bottom:0.5rem;">🛡️</div><div class="ssr-card-title">PCI DSS Compliant</div><div class="ssr-card-text">Level 1 certified</div></div>
        <div class="ssr-card" style="text-align:center;"><div style="font-size:1.5rem;margin-bottom:0.5rem;">🔒</div><div class="ssr-card-title">SSL Encrypted</div><div class="ssr-card-text">256-bit encryption</div></div>
        <div class="ssr-card" style="text-align:center;"><div style="font-size:1.5rem;margin-bottom:0.5rem;">🏅</div><div class="ssr-card-title">BBB Accredited</div><div class="ssr-card-text">A+ rating</div></div>
        <div class="ssr-card" style="text-align:center;"><div style="font-size:1.5rem;margin-bottom:0.5rem;">⚡</div><div class="ssr-card-title">No Contract Required</div><div class="ssr-card-text">Month-to-month</div></div>
      </div>
    </div>
  </section>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Frequently Asked Questions</h2>
      <div class="ssr-faq-wrapper">
        ${faqHtml}
      </div>
    </div>
  </section>

  ${ctaSection("Not Signing Up Feels Irrational", "Either we find you savings — or we pay you $50. There is no scenario where you lose.")}`;

  return ssrHtmlShell({
    title: "Free Statement Analysis — Guaranteed Savings | Liberty Bancard",
    description: "Upload your statement and we'll find hidden fees, benchmark against 3,200+ statements, and show what you should pay. No savings? We'll send you a $50 gift card.",
    canonical: "/free-analysis-guaranteed",
    keywords: "free merchant statement analysis, guaranteed savings, payment processing review, hidden fees, merchant services benchmark",
    schemaJsons: [faqSchema, serviceSchema],
    body,
  });
}

export function getFreeSmartTerminalHtml(): string {
  const serviceSchema = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: FST_SERVICE_NAME,
    description: FST_SERVICE_DESCRIPTION,
    url: `${BASE_URL}${FST_PATH}`,
    provider: { "@type": "Organization", name: "Liberty Bancard", url: BASE_URL },
    areaServed: { "@type": "Country", name: "United States" },
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: BASE_URL },
      { "@type": "ListItem", position: 2, name: "Free Smart Terminal", item: `${BASE_URL}${FST_PATH}` },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: fstFaqItems.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  const body = `
  <div class="ssr-hero">
    <div class="ssr-hero-inner">
      <div class="ssr-breadcrumb"><a href="/">Home</a><span>/</span><span>Free Smart Terminal</span></div>
      <div class="ssr-hero-badge">📱 Smart Terminal Program</div>
      <h1>See If Your Business Qualifies for a Smart Terminal at No Upfront Cost</h1>
      <p class="ssr-hero-subtitle">Qualifying merchants who open a Liberty Bancard processing account may receive terminal placement with no purchase cost. We review your statement to confirm eligibility — no guesswork, no pressure.</p>
      <div class="ssr-hero-buttons">
        <a href="/get-started?offer=free-terminal" class="ssr-btn-primary">📋 Check My Eligibility</a>
        <a href="/upload-statement" class="ssr-btn-outline">📤 Upload Statement First</a>
      </div>
    </div>
  </div>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Terminal Eligibility Requirements</h2>
      <div class="ssr-grid-2" style="max-width:48rem;margin:0 auto;">
        <div class="ssr-card"><div class="ssr-card-title">✅ New Processing Account</div><div class="ssr-card-text">Open a new Liberty Bancard processing account to qualify for terminal placement.</div></div>
        <div class="ssr-card"><div class="ssr-card-title">💳 Monthly Volume $5,000+</div><div class="ssr-card-text">Merchants processing at least $5,000/month in card volume typically qualify.</div></div>
        <div class="ssr-card"><div class="ssr-card-title">🔓 No Active Equipment Lease</div><div class="ssr-card-text">Not currently under an existing equipment lease or locked-in terminal contract.</div></div>
        <div class="ssr-card"><div class="ssr-card-title">📋 Standard Underwriting</div><div class="ssr-card-text">Approved through standard merchant underwriting — same process as any new account.</div></div>
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Available Smart Terminals</h2>
      <div class="ssr-grid-2" style="max-width:40rem;margin:0 auto;">
        <div class="ssr-card" style="text-align:center;"><div style="font-size:2rem;margin-bottom:0.5rem;">📱</div><div class="ssr-card-title">Clover Flex 3</div><div class="ssr-card-text">Portable smart terminal with built-in receipt printer. Ideal for table-side, counter, and mobile use.</div></div>
        <div class="ssr-card" style="text-align:center;"><div style="font-size:2rem;margin-bottom:0.5rem;">📟</div><div class="ssr-card-title">PAX A920</div><div class="ssr-card-text">All-in-one Android smart terminal with touchscreen. Accepts tap, chip, and swipe payments.</div></div>
      </div>
      <p style="text-align:center;margin-top:1.5rem;font-size:0.9rem;color:#6b7280;">Terminal model confirmed after statement review based on your business type and volume.</p>
    </div>
  </section>

  <section class="ssr-section ssr-section-muted">
    <div class="ssr-section-inner">
      <h2 class="ssr-section-heading">Frequently Asked Questions</h2>
      <div class="ssr-faq-wrapper">
        ${fstFaqItems.map((item) => `<div class="ssr-faq-item"><div class="ssr-faq-q">${item.question}</div><div class="ssr-faq-a">${item.answer}</div></div>`).join("\n        ")}
      </div>
    </div>
  </section>

  <section class="ssr-section">
    <div class="ssr-section-inner">
      <h3 style="text-align:center;font-size:0.95rem;font-weight:600;color:#6b7280;margin-bottom:1rem;">Also useful:</h3>
      <div style="display:flex;flex-wrap:wrap;gap:1.5rem;justify-content:center;font-size:0.9rem;">
        <a href="/upload-statement" style="color:#3b82f6;">Upload Your Statement for a Free Review</a>
        <a href="/free-analysis" style="color:#3b82f6;">Get a Free Processing Analysis</a>
        <a href="/industries/restaurant-payment-processing" style="color:#3b82f6;">Restaurant Payment Processing</a>
        <a href="/industries/retail-payment-processing" style="color:#3b82f6;">Retail Payment Processing</a>
      </div>
    </div>
  </section>

  ${ctaSection("Check Your Eligibility Today", "Upload your statement and we'll confirm whether your business qualifies for terminal placement at no upfront cost.")}`;

  return ssrHtmlShell({
    title: FST_TITLE_FULL,
    description: FST_DESCRIPTION,
    canonical: FST_PATH,
    keywords: FST_KEYWORDS,
    schemaJsons: [serviceSchema, breadcrumbSchema, faqSchema],
    body,
  });
}
