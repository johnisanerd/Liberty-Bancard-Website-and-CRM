// Single source of truth for the "Free Statement Review" explainer copy shown
// on /upload-statement. Both the React page and the server-rendered shell
// import this module so the two can never drift apart.

export const FSR_HEADING = "Free Statement Review";

export const FSR_WHAT_IT_IS = {
  heading: "What the review is",
  intro:
    "A statement review is a line-by-line explanation of your current processing statement. We separate every charge into its two parts:",
  parts: [
    {
      term: "Interchange",
      text: "the actual card network cost. It is set by the card networks and your bank, and it passes through.",
    },
    {
      term: "Markup",
      text: "everything added on top of interchange by your processor.",
    },
  ],
  outro:
    "For each fee on your statement, we identify what it is, who charges it, and whether it is network cost or markup — so you can see exactly what payment processing actually costs your business, in plain English.",
} as const;

export const FSR_WHAT_YOU_RECEIVE = {
  heading: "What you receive",
  text:
    "A report covering your effective rate, your markup, your monthly fees, and the charges we identified, explained line by line. Our team analyzes every line item within 1 business day. Keep the analysis either way — there is no obligation to switch.",
} as const;

export const FSR_COST = {
  heading: "Cost",
  text: "The review is free. No cost, no commitment required, and no obligation to change processors.",
} as const;

export const FSR_WHAT_TO_SUBMIT = {
  heading: "What to submit, and how",
  paragraphs: [
    "Submit your most recent processing statement — any processor, any format — using the secure upload form on this page.",
    "Please don't send financial documents by email, text, or social media messages. The upload form on this page is the secure way to send us your statement. If a statement reaches us any other way, we will ask you to resend it here.",
  ],
} as const;

export const FSR_HANDLING = {
  heading: "How your documents are handled",
  text:
    "Your statement is used only to prepare your review. Access is limited to the team performing the review. We do not sell your information, and we do not share your statement outside the review. If you decide to become a Liberty Bancard merchant, any documents needed for your application are requested and handled separately during onboarding.",
} as const;

export const FSR_WHO_QUALIFIES = {
  heading: "Who qualifies",
  text:
    "Any business that currently accepts card payments and has a recent processing statement can request a review. Processing with Liberty Bancard requires an approved merchant account; accounts are subject to application, credit approval, and underwriting, and most applications are approved within 1–2 business days.",
} as const;

export const FSR_FUNDING_NOTE = {
  heading: "A note on funding",
  text:
    "Qualified merchants receive next-day funding. Actual timing depends on cutoff times, bank schedules, and risk review. Your rep will outline your specific funding timeline during onboarding.",
} as const;

export const FSR_DISCLOSURE = "Liberty Bancard is a registered ISO/MSP, not a bank.";

/** Anchor text for the plain links added to the homepage review sections. */
export const FSR_HOME_LINK_TEXT = "What we check — and how your documents are handled";
/** Anchor id of the explainer on /upload-statement. */
export const FSR_ANCHOR_ID = "free-statement-review";
