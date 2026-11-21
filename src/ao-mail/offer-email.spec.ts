import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TenderWithAnalysis } from '../tenders/tenders.repository';
import { frenchDeadline, renderOfferEmail } from './offer-email';

// Fictitious offer, shaped like a stored relevant offer.
const offer: TenderWithAnalysis = {
  id: 1,
  site: 'partenaire-gc',
  external_id: 'acme-tech-lead-java',
  title: 'Tech lead Java',
  buyer: 'ACME BANQUE — ACME FINANCE',
  description: 'Code affaire : AB012345 · Lieu : Lyon · 650.00€ / jour',
  url: 'https://partenaire-gc.com/consultations/acme-tech-lead-java',
  published_at: '2026-11-10T10:00:00.000Z',
  deadline_at: '2026-11-18T10:00:00.000Z',
  cpv_codes: null,
  region: 'Lyon',
  contract_type: null,
  first_seen_at: '2026-11-12 09:00:00',
  last_seen_at: '2026-11-12 09:00:00',
  analysis: {
    outcome: 'relevant',
    categories: ['developpement_logiciel_saas'],
    summary: 'Mission de tech lead.',
    skills: ['Java', 'Spring'],
    seniority: null,
    duration: null,
    startDate: null,
    remote: null,
    missionText: 'Contexte de la mission\n\nPilotage technique <équipe> & revues.',
    model: 'test-model',
    analyzedAt: '2026-11-12 09:00:00',
  },
};

describe('frenchDeadline', () => {
  it('shows the Paris date and time, summer and winter time included', () => {
    assert.equal(frenchDeadline('2026-11-18T10:00:00.000Z'), '18/11/2026 à 11:00');
    assert.equal(frenchDeadline('2026-07-01T10:00:00.000Z'), '01/07/2026 à 12:00');
  });
});

describe('renderOfferEmail', () => {
  const email = renderOfferEmail(offer);

  it('uses the labels MyBestConsultant extracts, the buyer as client', () => {
    assert.equal(email.subject, "Appel d'offres — ACME BANQUE — ACME FINANCE — Tech lead Java");
    for (const line of [
      'Intitulé : Tech lead Java',
      'Client : ACME BANQUE — ACME FINANCE',
      'Lieu : Lyon',
      'Compétences : Java, Spring',
      'Date limite de réponse : 18/11/2026 à 11:00',
      'Référence : partenaire-gc:acme-tech-lead-java',
      'Offre en ligne : https://partenaire-gc.com/consultations/acme-tech-lead-java',
    ]) {
      assert.ok(email.text.includes(line), line);
    }
    assert.match(email.text, /Description\n-----------\nContexte de la mission/);
  });

  it('escapes the offer text in the HTML version', () => {
    assert.match(email.html, /Pilotage technique &lt;équipe&gt; &amp; revues\./);
    assert.doesNotMatch(email.html, /<équipe>/);
  });

  it('links only to the offer\'s own site', () => {
    for (const url of ['https://evil.example/consultations/acme-tech-lead-java', 'http://partenaire-gc.com/x']) {
      const email = renderOfferEmail({ ...offer, url });
      assert.match(email.text, /Offre en ligne : lien indisponible/, url);
      assert.doesNotMatch(email.html, /evil\.example|http:\/\//, url);
    }
  });

  it('leaves out missing fields and never links a non-https URL', () => {
    const bare = renderOfferEmail({ ...offer, region: null, deadline_at: null, url: 'javascript:alert(1)', analysis: null });
    assert.doesNotMatch(bare.text, /^(Lieu|Date limite de réponse|Compétences) :/m);
    assert.match(bare.text, /Offre en ligne : lien indisponible/);
    assert.doesNotMatch(bare.html, /javascript:/);
    assert.match(bare.text, /Pas de description enregistrée/);
  });

  it('lists the attached documents and the others with the reason, escaped in the HTML version', () => {
    const withDocuments = renderOfferEmail(offer, {
      attached: ['cdc.pdf', 'annexe.docx'],
      notAttached: [{ name: 'matrice<1>.xlsx', reason: 'tableur, à télécharger sur l’offre en ligne' }],
    });
    assert.ok(withDocuments.text.includes('Documents joints : cdc.pdf, annexe.docx'));
    assert.ok(withDocuments.text.includes('Documents non joints : matrice<1>.xlsx (tableur, à télécharger sur l’offre en ligne)'));
    assert.ok(withDocuments.html.includes('matrice&lt;1&gt;.xlsx'));
    assert.doesNotMatch(email.text, /Documents/, 'no document lines without documents');
  });

  it('shortens a very long subject', () => {
    assert.equal(renderOfferEmail({ ...offer, title: 'x'.repeat(300) }).subject.length, 180);
  });
});
