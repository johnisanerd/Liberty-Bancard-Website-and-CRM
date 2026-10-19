/**
 * The one renderer for SFP launch step wording. The sequence worker and the operator seed test both call it, so a
 * seed message is rendered exactly as a real recipient's message would be.
 */
import { renderTemplate, plainHtmlToEmailHtml } from "./message-render";
import { resolvePolicy } from "./sender-policy";
import { SFP_LAUNCH_ALLOWED_HOSTS, applySfpLaunchPresentation } from "./cro03/sfp-launch-presentation";

export interface SfpLaunchRecipientFacts {
  firstName?: string | null; lastName?: string | null; companyName?: string | null; email?: string | null;
}

export function sfpLaunchRenderContext(contact: SfpLaunchRecipientFacts | null | undefined) {
  const sender = resolvePolicy("cold_outreach");
  return {
    firstName: contact?.firstName ?? null, lastName: contact?.lastName ?? null,
    companyName: contact?.companyName ?? null, email: contact?.email ?? null,
    agentName: sender.displayName, agentEmail: sender.replyTo, agentPhone: "954-266-8214",
  };
}

type Ctx = ReturnType<typeof sfpLaunchRenderContext>;

export const renderSfpLaunchSubject = (text: string | null | undefined, ctx: Ctx) =>
  renderTemplate(text ?? "", ctx, { format: "subject", required: ["companyName"] }).output;

/**
 * Finished launch body: the step's paragraphs plus the shared signature and logo. The step text itself carries no
 * signature (the presentation owns it, so it can never appear twice) and the transport adds the one footer.
 */
export const renderSfpLaunchBodyHtml = (text: string | null | undefined, ctx: Ctx) => {
  const body = plainHtmlToEmailHtml(
    renderTemplate(text ?? "", ctx, { format: "html", required: ["companyName"] }).output,
    SFP_LAUNCH_ALLOWED_HOSTS,
  );
  return applySfpLaunchPresentation(body, { agentName: ctx.agentName, agentPhone: ctx.agentPhone });
};
