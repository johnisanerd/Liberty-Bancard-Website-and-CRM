/** A retained snapshot of fields actually supplied by an intake source. Missing
 * identifiers remain missing; this does not read or borrow local CRM authority. */
export function intakeBusinessEvidence(input:{
  companyName?:unknown;website?:unknown;phone?:unknown;address?:unknown;city?:unknown;state?:unknown;
}) {
  const text=(value:unknown)=>typeof value==="string" && value.trim() ? value.trim() : null;
  return {canonicalName:text(input.companyName),websiteDomain:text(input.website),
    mainPhone:text(input.phone),streetAddress:text(input.address),city:text(input.city),state:text(input.state)};
}
