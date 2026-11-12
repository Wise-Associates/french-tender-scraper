import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesKeywords, PartenaireGcRow, toPartenaireGcTender } from './partenaire-gc.listing';

// Fictitious offer, shaped like a row of the "Consultations en cours" listing.
const row: PartenaireGcRow = {
  href: '/consultations/acme-expert-securite-applicative',
  title: 'Expert Sécurité Applicative',
  enseigne: 'ACME BANQUE',
  filiale: 'ACME FINANCE',
  publishedAt: '2026-11-10T11:35:34+01:00',
  deadlineAt: '2026-11-16T11:00:00Z',
  code: 'Code affaire : AB012345',
  lieu: 'Lieu : Lyon',
  tarif: '650.00€ / jour',
  commission: 'PGC 7.00% + RFA 2.00%',
  delai: 'Délai règlement : 45j',
};
const pageUrl = 'https://partenaire-gc.com/espace-abonne?page=1';

describe('toPartenaireGcTender', () => {
  it('maps every field of a complete offer', () => {
    const tender = toPartenaireGcTender(row, pageUrl);
    assert.equal(tender.site, 'partenaire-gc');
    assert.equal(tender.externalId, 'acme-expert-securite-applicative');
    assert.equal(tender.url, 'https://partenaire-gc.com/consultations/acme-expert-securite-applicative');
    assert.equal(tender.title, 'Expert Sécurité Applicative');
    assert.equal(tender.buyer, 'ACME BANQUE — ACME FINANCE');
    assert.equal(tender.publishedAt, '2026-11-10T10:35:34.000Z');
    assert.equal(tender.deadlineAt, '2026-11-16T11:00:00.000Z');
    assert.equal(tender.region, 'Lyon');
    assert.equal(
      tender.description,
      'Code affaire : AB012345 · Lieu : Lyon · 650.00€ / jour · PGC 7.00% + RFA 2.00% · Délai règlement : 45j',
    );
  });

  it('leaves out the fields an offer does not show', () => {
    const tender = toPartenaireGcTender({ ...row, filiale: '', lieu: '', tarif: '', deadlineAt: '' }, pageUrl);
    assert.equal(tender.buyer, 'ACME BANQUE');
    assert.equal(tender.region, undefined);
    assert.equal(tender.deadlineAt, undefined);
    assert.equal(tender.description, 'Code affaire : AB012345 · PGC 7.00% + RFA 2.00% · Délai règlement : 45j');
  });

  it('ignores an unreadable date instead of storing it', () => {
    assert.equal(toPartenaireGcTender({ ...row, publishedAt: '12/11/2026' }, pageUrl).publishedAt, undefined);
  });
});

describe('matchesKeywords', () => {
  const tender = toPartenaireGcTender(row, pageUrl);

  it('keeps every offer when no keyword is given', () => {
    assert.equal(matchesKeywords(tender), true);
    assert.equal(matchesKeywords(tender, ['  ']), true);
  });

  it('matches any keyword, ignoring case and accents', () => {
    assert.equal(matchesKeywords(tender, ['devops', 'SECURITE']), true);
  });

  it('matches on the buyer and the description too', () => {
    assert.equal(matchesKeywords(tender, ['acme finance']), true);
    assert.equal(matchesKeywords(tender, ['lyon']), true);
  });

  it('rejects an offer that matches no keyword', () => {
    assert.equal(matchesKeywords(tender, ['comptabilité', 'scrum']), false);
  });
});
