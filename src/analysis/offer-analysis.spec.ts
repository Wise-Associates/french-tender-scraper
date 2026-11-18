import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Tender } from '../scrapers/tender.types';
import {
  buildOfferPrompt,
  DEFAULT_MAX_PER_RUN,
  interpretOpenAiResponse,
  interpretResponse,
  maskAnalysis,
  maskContactDetails,
  OfferAnalysis,
  parseMaxPerRun,
} from './offer-analysis';

// Fictitious offer and contact details.
const tender: Tender = {
  site: 'partenaire-gc',
  externalId: 'acme-tech-lead-java',
  title: 'Tech lead Java',
  buyer: 'ACME BANQUE — ACME FINANCE',
  region: 'Lyon',
  url: 'https://partenaire-gc.com/consultations/acme-tech-lead-java',
};
const analysis: OfferAnalysis = {
  categories: ['developpement_logiciel_saas'],
  summary: 'Mission de tech lead Java.',
  skills: ['Java', 'Spring'],
  seniority: '8 ans',
  duration: '6 mois',
  start_date: null,
  remote: '2 jours par semaine',
};
const answer = (value: unknown) => ({ type: 'text', text: JSON.stringify(value) });

describe('maskContactDetails', () => {
  it('masks email addresses, including obfuscated and accented ones', () => {
    for (const email of [
      'jean.dupont@acme-banque.fr',
      'rené.dupont@acme.fr',
      'contact@société.fr',
      'jean.dupont [at] acme.fr',
      'jean.dupont(at)acme.fr',
      'jean.dupont @ acme.fr',
      'jean.dupont＠acme.fr',
    ]) {
      assert.equal(maskContactDetails(`Contact : ${email}.`), 'Contact : [email masqué].', email);
    }
  });

  it('masks French and foreign phone numbers in common formats', () => {
    for (const phone of [
      '06 12 34 56 78',
      '01.23.45.67.89',
      '0123456789',
      '06/12/34/56/78',
      '06–12–34–56–78',
      '06  12 34 56 78',
      '+33 6 12 34 56 78',
      '+33 (0)1 23 45 67 89',
      '0033 6 12 34 56 78',
      '0033612345678',
      '+32 2 123 45 67',
      '+41 22 123 45 67',
      '+44 20 7946 0958',
    ]) {
      assert.equal(maskContactDetails(`Tél ${phone} !`), 'Tél [téléphone masqué] !', phone);
    }
  });

  it('keeps dates, amounts, codes and company numbers', () => {
    const text = 'Démarrage le 01/12/2026, TJM 650.00€, code DH039349, SIRET 01234567890123, 45j, 2024-2026.';
    assert.equal(maskContactDetails(text), text);
  });
});

describe('maskAnalysis', () => {
  it('masks contact details Claude copied into its answer', () => {
    const masked = maskAnalysis({ ...analysis, summary: 'Écrire à rh@acme.fr.', remote: 'Appeler le 06 12 34 56 78' });
    assert.equal(masked.summary, 'Écrire à [email masqué].');
    assert.equal(masked.remote, 'Appeler le [téléphone masqué]');
    assert.deepEqual(masked.skills, ['Java', 'Spring']);
  });
});

describe('buildOfferPrompt', () => {
  it('includes the listing fields and the masked mission text', () => {
    const prompt = buildOfferPrompt(tender, 'Écrire à rh@acme.fr pour postuler.');
    assert.match(prompt, /Titre : Tech lead Java/);
    assert.match(prompt, /Client : ACME BANQUE — ACME FINANCE/);
    assert.match(prompt, /Lieu : Lyon/);
    assert.match(prompt, /<offre>\nÉcrire à \[email masqué\] pour postuler\.\n<\/offre>/);
    assert.doesNotMatch(prompt, /rh@acme\.fr/);
  });
});

describe('interpretResponse', () => {
  it('is relevant when at least one category matches, without duplicates', () => {
    const result = interpretResponse({
      stop_reason: 'end_turn',
      content: [answer({ ...analysis, categories: ['data_ia', 'data_ia', 'pilotage_it_agile'] })],
    });
    assert.equal(result.kind, 'relevant');
    assert.deepEqual(result.kind === 'relevant' && result.analysis.categories, ['data_ia', 'pilotage_it_agile']);
  });

  it('is not relevant when no category matches', () => {
    assert.deepEqual(interpretResponse({ stop_reason: 'end_turn', content: [answer({ ...analysis, categories: [] })] }), {
      kind: 'not_relevant',
    });
  });

  it('records a refusal even when it carries partial text', () => {
    assert.deepEqual(
      interpretResponse({
        stop_reason: 'refusal',
        stop_details: { category: 'general_harms' },
        content: [{ type: 'text', text: '{"categ' }],
      }),
      { kind: 'refused', category: 'general_harms' },
    );
  });

  it('reads the last text block, written by the model that answered after a fallback', () => {
    const result = interpretResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Je ne peux' }, { type: 'fallback' }, answer(analysis)],
    });
    assert.equal(result.kind, 'relevant');
  });

  it('marks truncated, non-JSON or off-schema answers as unusable, without quoting them', () => {
    const truncated = interpretResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"summary": "Mis' }] });
    assert.deepEqual(truncated, { kind: 'unusable', reason: 'stop_reason "max_tokens"' });

    const notJson = interpretResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Voici mon analyse' }] });
    assert.deepEqual(notJson, { kind: 'unusable', reason: 'the answer is not valid JSON' });

    const offSchema = interpretResponse({ stop_reason: 'end_turn', content: [answer({ ...analysis, categories: ['cloud'] })] });
    assert.equal(offSchema.kind, 'unusable');
    assert.doesNotMatch(offSchema.kind === 'unusable' ? offSchema.reason : '', /cloud/);
  });
});

describe('interpretOpenAiResponse', () => {
  const completion = (finish_reason: string | null, message: { content?: string | null; refusal?: string | null }) => ({
    choices: [{ finish_reason, message }],
  });

  it('reads the JSON answer with the same rules as Claude', () => {
    const result = interpretOpenAiResponse(completion('stop', { content: JSON.stringify({ ...analysis, categories: ['data_ia', 'data_ia'] }) }));
    assert.deepEqual(result.kind === 'relevant' && result.analysis.categories, ['data_ia']);
    assert.deepEqual(interpretOpenAiResponse(completion('stop', { content: JSON.stringify({ ...analysis, categories: [] }) })), {
      kind: 'not_relevant',
    });
  });

  it('records a refusal or a filtered answer once', () => {
    assert.deepEqual(interpretOpenAiResponse(completion('stop', { content: null, refusal: 'I cannot help with that.' })), {
      kind: 'refused',
      category: null,
    });
    assert.deepEqual(interpretOpenAiResponse(completion('content_filter', { content: null })), {
      kind: 'refused',
      category: 'content_filter',
    });
  });

  it('marks truncated, empty, non-JSON or off-schema answers as unusable', () => {
    assert.deepEqual(interpretOpenAiResponse(completion('length', { content: '{"summ' })), {
      kind: 'unusable',
      reason: 'finish_reason "length"',
    });
    assert.deepEqual(interpretOpenAiResponse({ choices: [] }), { kind: 'unusable', reason: 'no choice in the answer' });
    assert.deepEqual(interpretOpenAiResponse(completion('stop', { content: '' })), { kind: 'unusable', reason: 'no text in the answer' });
    assert.deepEqual(interpretOpenAiResponse(completion('stop', { content: 'Voici' })), {
      kind: 'unusable',
      reason: 'the answer is not valid JSON',
    });
    assert.equal(interpretOpenAiResponse(completion('stop', { content: JSON.stringify({ ...analysis, categories: ['cloud'] }) })).kind, 'unusable');
  });
});

describe('parseMaxPerRun', () => {
  it('uses the default when unset or empty', () => {
    assert.equal(parseMaxPerRun(undefined), DEFAULT_MAX_PER_RUN);
    assert.equal(parseMaxPerRun(''), DEFAULT_MAX_PER_RUN);
    assert.equal(parseMaxPerRun('  '), DEFAULT_MAX_PER_RUN);
  });

  it('accepts a whole number, 0 included (analysis paused)', () => {
    assert.equal(parseMaxPerRun('10'), 10);
    assert.equal(parseMaxPerRun('0'), 0);
  });

  it('rejects anything else', () => {
    for (const raw of ['ten', '-1', '2.5']) assert.throws(() => parseMaxPerRun(raw), /ANALYSIS_MAX_PER_RUN/, raw);
  });
});
