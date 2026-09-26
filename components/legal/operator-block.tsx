import { SITE, operatorIsKnown } from '@/lib/site';

/**
 * The operator's identity, as the law requires it to be stated.
 *
 * Read from lib/site.ts so the terms, the privacy policy and the cookies page
 * cannot disagree. Until the company details are filled in, this says so in
 * plain words instead of inventing a company or hiding the gap.
 */
export function OperatorBlock() {
  const o = SITE.operator;
  if (!operatorIsKnown()) {
    return (
      <p>
        Identifikačné údaje prevádzkovateľa (obchodné meno, IČO, sídlo) doplníme pred
        verejným spustením služby. Do tej doby nás kontaktujte na{' '}
        <a href={`mailto:${SITE.contactEmail}`} className="text-primary hover:underline">
          {SITE.contactEmail}
        </a>
        .
      </p>
    );
  }
  return (
    <p>
      <strong>{o.name}</strong>
      <br />
      {o.address}
      <br />
      IČO: {o.ico}
      {o.dic ? <>, DIČ: {o.dic}</> : null}
      {o.icDph ? <>, IČ DPH: {o.icDph}</> : null}
      {o.register ? (
        <>
          <br />
          {o.register}
        </>
      ) : null}
      <br />
      Kontakt:{' '}
      <a href={`mailto:${SITE.contactEmail}`} className="text-primary hover:underline">
        {SITE.contactEmail}
      </a>
    </p>
  );
}
