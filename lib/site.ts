// Who runs the site. Legal pages, the footer and every "contact us" link read
// from here, so the operator's identity is stated once and cannot drift
// between the terms, the privacy policy and the footer.
//
// Slovak e-commerce law and GDPR Art. 13 both require the operator to be
// identified by name, IČO and registered seat. Until those are filled in the
// legal pages say so openly rather than inventing a company.
export const SITE = {
  name: 'CPCProfit',
  contactEmail: 'hello@cpcprofit.sk',
  privacyEmail: 'privacy@cpcprofit.sk',
  operator: {
    name: null as string | null,
    ico: null as string | null,
    dic: null as string | null,
    icDph: null as string | null,
    address: null as string | null,
    register: null as string | null,
  },
} as const;

export function operatorIsKnown(): boolean {
  return SITE.operator.name != null && SITE.operator.ico != null && SITE.operator.address != null;
}
