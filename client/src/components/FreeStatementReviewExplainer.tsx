import type { ReactNode } from "react";
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

function Block({ heading, testId, children }: { heading: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId}>
      <h3 className="text-base font-bold text-gray-900 mb-1.5">{heading}</h3>
      <div className="space-y-2 text-sm leading-relaxed text-gray-600">{children}</div>
    </div>
  );
}

/** Explainer shown above the upload form: what the review is, what you get, cost. */
export function FreeStatementReviewIntro() {
  return (
    <section
      id={FSR_ANCHOR_ID}
      className="bg-white px-5 pt-8 pb-4"
      data-testid="section-free-statement-review"
    >
      <div className="max-w-lg mx-auto space-y-6">
        <h2 className="text-2xl font-bold text-gray-900" data-testid="text-free-statement-review-heading">
          {FSR_HEADING}
        </h2>
        <Block heading={FSR_WHAT_IT_IS.heading} testId="block-fsr-what-it-is">
          <p>{FSR_WHAT_IT_IS.intro}</p>
          <ul className="list-disc pl-5 space-y-1">
            {FSR_WHAT_IT_IS.parts.map((part) => (
              <li key={part.term}>
                <strong className="text-gray-900">{part.term}</strong> — {part.text}
              </li>
            ))}
          </ul>
          <p>{FSR_WHAT_IT_IS.outro}</p>
        </Block>
        <Block heading={FSR_WHAT_YOU_RECEIVE.heading} testId="block-fsr-what-you-receive">
          <p>{FSR_WHAT_YOU_RECEIVE.text}</p>
        </Block>
        <Block heading={FSR_COST.heading} testId="block-fsr-cost">
          <p>{FSR_COST.text}</p>
        </Block>
      </div>
    </section>
  );
}

/** Sits directly above the upload form. */
export function FreeStatementReviewSubmitGuidance() {
  return (
    <section className="bg-white px-5 pt-2 pb-2" data-testid="section-fsr-what-to-submit">
      <div className="max-w-lg mx-auto rounded-2xl border border-sky-100 bg-sky-50/60 p-4">
        <Block heading={FSR_WHAT_TO_SUBMIT.heading} testId="block-fsr-what-to-submit">
          {FSR_WHAT_TO_SUBMIT.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </Block>
      </div>
    </section>
  );
}

/** Shown below the upload form: handling, eligibility, funding and ISO disclosure. */
export function FreeStatementReviewDetails() {
  return (
    <section className="bg-white px-5 pt-2 pb-8" data-testid="section-fsr-details">
      <div className="max-w-lg mx-auto space-y-6">
        <Block heading={FSR_HANDLING.heading} testId="block-fsr-handling">
          <p>{FSR_HANDLING.text}</p>
        </Block>
        <Block heading={FSR_WHO_QUALIFIES.heading} testId="block-fsr-who-qualifies">
          <p>{FSR_WHO_QUALIFIES.text}</p>
        </Block>
        <Block heading={FSR_FUNDING_NOTE.heading} testId="block-fsr-funding">
          <p>{FSR_FUNDING_NOTE.text}</p>
        </Block>
        <p className="text-xs text-gray-500" data-testid="text-fsr-disclosure">
          {FSR_DISCLOSURE}
        </p>
      </div>
    </section>
  );
}
