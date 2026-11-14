import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchedItKeywords } from './it-keywords';

// Fictitious mission texts.
describe('matchedItKeywords', () => {
  it('finds IT, software development and SaaS terms, ignoring case and accents', () => {
    assert.deepEqual(matchedItKeywords('Développement LOGICIEL pour un éditeur SaaS'), ['developpement logiciel', 'saas']);
    assert.deepEqual(matchedItKeywords('Développeur Java / Spring, API REST'), ['developpeur', 'java', 'api']);
  });

  it('covers IT steering, agile, data and AI', () => {
    assert.deepEqual(matchedItKeywords('Scrum Master pour une équipe agile'), ['scrum master', 'agile']);
    assert.deepEqual(matchedItKeywords('Data engineer, Power BI et machine learning'), ['data', 'power bi', 'machine learning', 'BI']);
  });

  it('matches short acronyms only in capitals', () => {
    assert.deepEqual(matchedItKeywords('Équipe IT au sein de la DSI'), ['IT', 'DSI']);
    assert.deepEqual(matchedItKeywords('Si besoin, il faudra se déplacer.'), []);
  });

  it('matches whole words only', () => {
    assert.deepEqual(matchedItKeywords('Javanais, apiculture et database-free'), []);
    assert.deepEqual(matchedItKeywords('Front-end et back-end'), ['front end', 'back end']);
  });

  it('finds nothing in a non-IT mission', () => {
    assert.deepEqual(matchedItKeywords('Comptabilité immobilière et trésorerie, clôtures mensuelles.'), []);
  });
});
