import { FSR_HOME_LINK_TEXT } from "@shared/free-statement-review-content";
import { ssrHtmlShell } from "../ssrShared";

export function getHomeHtml(): string {
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Liberty Bancard",
    url: "https://libertybancard.com",
    telephone: "+1-954-266-8214",
    email: "support@libertybancard.com",
    description: "Transparent merchant payment processing with interchange-plus pricing, 0% processing programs, and dedicated support for small businesses.",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Fort Lauderdale",
      addressRegion: "FL",
      addressCountry: "US",
    },
    sameAs: [],
  };

  const localBusinessSchema = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "Liberty Bancard",
    description: "Transparent merchant payment processing with interchange-plus pricing and dedicated support.",
    url: "https://libertybancard.com",
    telephone: "+1-954-266-8214",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Fort Lauderdale",
      addressRegion: "FL",
      addressCountry: "US",
    },
    priceRange: "$$",
    openingHours: "Mo-Fr 09:00-18:00",
  };

  const webSiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Liberty Bancard",
    url: "https://libertybancard.com",
    potentialAction: {
      "@type": "SearchAction",
      target: "https://libertybancard.com/blog?q={search_term_string}",
      "query-input": "required name=search_term_string",
    },
  };

  const body = `
    <div class="ssr-hero">
      <div class="ssr-hero-inner">
        <div class="ssr-hero-badge">South Florida Merchant Services</div>
        <h1>Credit Card Processing Without the Rate Games</h1>
        <p class="ssr-hero-subtitle">
          Upload a recent processing statement and we'll show your effective rate, markup, monthly fees, and hidden charges — before you switch.
        </p>
        <div class="ssr-hero-buttons">
          <a href="/upload-statement" class="ssr-btn-primary">Upload My Statement — Free</a>
          <a href="/free-analysis" class="ssr-btn-outline">Free Savings Analysis</a>
        </div>
      </div>
    </div>

    <section class="ssr-section ssr-section-muted">
      <div class="ssr-section-inner">
        <div class="ssr-grid-3">
          <div class="ssr-card" style="text-align:center;">
            <!-- source: Internal — company founding year, verified Aug 2026 -->
            <!-- measuredAs: Calendar years of operation from founding -->
            <div class="ssr-stat-value">10+</div>
            <div class="ssr-stat-label">Years in Business</div>
          </div>
          <div class="ssr-card" style="text-align:center;">
            <!-- source: Internal — CRM cumulative merchant count, last verified Aug 2026 -->
            <!-- measuredAs: Cumulative approved merchant accounts, all-time -->
            <div class="ssr-stat-value">5,000+</div>
            <div class="ssr-stat-label">Merchants Served</div>
          </div>
          <div class="ssr-card" style="text-align:center;">
            <div class="ssr-stat-value">FL-Based</div>
            <div class="ssr-stat-label">South Florida Team</div>
          </div>
        </div>
      </div>
    </section>

    <section class="ssr-section">
      <div class="ssr-section-inner">
        <h2 class="ssr-section-heading">What We Do Differently</h2>
        <p class="ssr-section-subheading">Most processors hide their margins in bundled rates. We don't.</p>
        <div class="ssr-grid-2">
          <div class="ssr-card ssr-pain-item">
            <div class="ssr-solution-icon">💲</div>
            <div>
              <div class="ssr-item-title">Interchange-Plus Pricing</div>
              <div class="ssr-item-text">You see the exact card network cost plus our transparent markup. No bundled rates, no hidden fees — just the truth about what payment processing actually costs.</div>
            </div>
          </div>
          <div class="ssr-card ssr-pain-item">
            <div class="ssr-solution-icon">📊</div>
            <div>
              <div class="ssr-item-title">Free Statement Review</div>
              <div class="ssr-item-text">Upload your current statement and we'll analyze every line item. We'll show you exactly what you're paying, why, and how much you'd save. No commitment required.</div>
            </div>
          </div>
          <div class="ssr-card ssr-pain-item">
            <div class="ssr-solution-icon">⚡</div>
            <div>
              <div class="ssr-item-title">Liberty Zero™ — 0% Processing</div>
              <div class="ssr-item-text">Our Liberty Zero™ program lets qualifying merchants eliminate credit card fees through compliant cash discount and surcharging. Available where permitted by state law and card brand rules.*</div>
            </div>
          </div>
          <div class="ssr-card ssr-pain-item">
            <div class="ssr-solution-icon">🤝</div>
            <div>
              <div class="ssr-item-title">Dedicated Account Rep</div>
              <div class="ssr-item-text">A real person who knows your business, answers when you call, and helps when something goes wrong. Not a call center, not a ticket system — a dedicated partner.</div>
            </div>
          </div>
          <div class="ssr-card ssr-pain-item">
            <div class="ssr-solution-icon">🏦</div>
            <div>
              <div class="ssr-item-title">Next-Day Funding</div>
              <div class="ssr-item-text">Qualified merchants receive deposits by the next business day. Keep your cash flow moving without waiting 3-5 days for your own money.*</div>
            </div>
          </div>
          <div class="ssr-card ssr-pain-item">
            <div class="ssr-solution-icon">🖥</div>
            <div>
              <div class="ssr-item-title">Free Terminal for Qualifying Merchants</div>
              <div class="ssr-item-text">Modern EMV, NFC, and contactless-ready terminals at no cost for qualifying accounts. Own your equipment without lease payments or end-of-term surprises.*</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="ssr-section ssr-section-muted">
      <div class="ssr-section-inner">
        <h2 class="ssr-section-heading">How the Free Statement Review Works</h2>
        <p class="ssr-section-subheading">Three steps to knowing exactly what payment processing should cost your business.</p>
        <div class="ssr-grid-3">
          <div class="ssr-card" style="text-align:center;">
            <div style="font-size:2rem;margin-bottom:0.75rem;">1️⃣</div>
            <div class="ssr-card-title">Upload Your Statement</div>
            <div class="ssr-card-text">Securely upload your most recent processing statement — any processor, any format. Takes 30 seconds.</div>
          </div>
          <div class="ssr-card" style="text-align:center;">
            <div style="font-size:2rem;margin-bottom:0.75rem;">2️⃣</div>
            <div class="ssr-card-title">We Analyze It</div>
            <div class="ssr-card-text">Our team reviews every line item and identifies your effective rate, hidden fees, and where you're overpaying.</div>
          </div>
          <div class="ssr-card" style="text-align:center;">
            <div style="font-size:2rem;margin-bottom:0.75rem;">3️⃣</div>
            <div class="ssr-card-title">See Your Savings</div>
            <div class="ssr-card-text">You get a clear comparison showing exactly how much you'd save with interchange-plus pricing. Keep the analysis either way.</div>
          </div>
        </div>
        <div style="text-align:center;margin-top:2rem;">
          <a href="/upload-statement" class="ssr-btn-dark">📤 Start Free Statement Review</a>
        </div>
        <p style="text-align:center;margin-top:1rem;"><a href="/upload-statement">${FSR_HOME_LINK_TEXT}</a></p>
      </div>
    </section>

    <section class="ssr-section">
      <div class="ssr-section-inner">
        <h2 class="ssr-section-heading">Industries We Serve</h2>
        <p class="ssr-section-subheading">Payment processing built around how your industry actually operates.</p>
        <div class="ssr-grid-3">
          <a href="/industries/restaurant-payment-processing" class="ssr-card" style="display:block;text-decoration:none;">
            <div class="ssr-card-title">🍽 Restaurant</div>
            <div class="ssr-card-text">Tip optimization, POS integration, next-day funding. Built for high-volume restaurant operations.</div>
          </a>
          <a href="/industries/retail-payment-processing" class="ssr-card" style="display:block;text-decoration:none;">
            <div class="ssr-card-title">🛍 Retail</div>
            <div class="ssr-card-text">Interchange-plus saves retailers on debit cards. Multi-location management, chargeback support.</div>
          </a>
          <a href="/industries/healthcare-payment-processing" class="ssr-card" style="display:block;text-decoration:none;">
            <div class="ssr-card-title">🏥 Healthcare</div>
            <div class="ssr-card-text">PCI-compliant solutions for medical and dental practices. Patient payment plans, clear reporting.</div>
          </a>
          <a href="/industries/salon-spa-payment-processing" class="ssr-card" style="display:block;text-decoration:none;">
            <div class="ssr-card-title">💇 Salon &amp; Spa</div>
            <div class="ssr-card-text">Card-on-file for no-shows, tip-optimized processing, software-agnostic integration.</div>
          </a>
          <a href="/industries/auto-repair-payment-processing" class="ssr-card" style="display:block;text-decoration:none;">
            <div class="ssr-card-title">🔧 Auto Repair</div>
            <div class="ssr-card-text">High-ticket optimization, fleet card acceptance, fast deposits for parts purchasing.</div>
          </a>
          <a href="/industries/professional-services-payment-processing" class="ssr-card" style="display:block;text-decoration:none;">
            <div class="ssr-card-title">💼 Professional Services</div>
            <div class="ssr-card-text">Virtual terminal, payment links for invoices, retainer billing, variable volume support.</div>
          </a>
        </div>
      </div>
    </section>

    <section class="ssr-section ssr-section-dark">
      <div class="ssr-section-inner">
        <div class="ssr-cta-section">
          <h2>Ready to Stop Overpaying for Payment Processing?</h2>
          <p>Upload your statement and we'll show you exactly what you're paying and exactly what you should be paying. Takes 30 seconds to start. No commitment required.</p>
          <div class="ssr-cta-buttons">
            <a href="/upload-statement" class="ssr-btn-primary">📤 Upload Statement — Free Review</a>
            <a href="tel:9542668214" class="ssr-btn-outline">📞 Call (954) 266-8214</a>
          </div>
        </div>
      </div>
    </section>
  `;

  return ssrHtmlShell({
    title: "Merchant Payment Processing | Liberty Bancard",
    description: "Liberty Bancard offers transparent interchange-plus payment processing. Free statement review, 0% processing programs, and dedicated merchant support.",
    canonical: "/",
    keywords: "merchant payment processing, interchange plus pricing, credit card processing, payment processor, merchant services, 0 percent processing, free statement review",
    schemaJsons: [orgSchema, localBusinessSchema, webSiteSchema],
    body,
  });
}
