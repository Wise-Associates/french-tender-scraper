/**
 * Free keyword filter applied before Claude: an offer whose title and mission
 * text mention none of these terms is not sent to Claude (no cost). The list
 * favours recall — Claude makes the precise decision with the categories of
 * offer-analysis.ts — and covers what Wise Associates asked for in November
 * 2026: IT, software development, SaaS and related fields (IT steering &
 * agile, data & AI). An offer filtered out is recorded and not checked again:
 * after changing this list, delete the `tender_analyses` rows whose model is
 * `keyword-filter` so they are checked again.
 */

/** Matched as whole words, ignoring case and accents. */
const PHRASES = [
  // IT in general
  'informatique', 'systeme d information', 'systemes d information', 'numerique', 'transformation digitale',
  // Software development & SaaS
  'logiciel', 'logiciels', 'progiciel', 'saas', 'editeur de logiciel', 'developpeur', 'developpeurs',
  'developpement logiciel', 'developpement applicatif', 'developpement informatique', 'developpement web',
  'developpement mobile', 'applicatif', 'applicative', 'applicatifs', 'application web', 'application mobile',
  'applications metier', 'architecture applicative', 'architecture logicielle', 'architecte logiciel',
  'tech lead', 'full stack', 'fullstack', 'front end', 'frontend', 'back end', 'backend', 'devops',
  'microservices', 'java', 'python', 'javascript', 'typescript', 'angular', 'react', 'php', 'api', 'apis',
  'integration continue', 'tests automatises', 'recette applicative',
  'erp', 'crm', 'sap', 'salesforce',
  // IT steering & agile
  'agile', 'agilite', 'scrum', 'safe', 'product owner', 'product manager', 'scrum master', 'chef de projet si',
  'chef de projet informatique', 'chef de projet it', 'amoa', 'moa', 'moe', 'pmo',
  // Data & AI
  'data', 'big data', 'business intelligence', 'decisionnel', 'power bi', 'machine learning',
  'intelligence artificielle', 'ia generative', 'llm',
];

/**
 * Short acronyms matched as whole words and only in capitals: in lowercase
 * they are ordinary French or English words (« si », « it »…).
 */
const ACRONYMS = ['IT', 'SI', 'DSI', 'IA', 'BI', 'QA'];

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

// Longest first: an alternation takes the first alternative that matches, and
// « scrum master » must not be reported as « scrum ».
const PHRASE_ALTERNATIVES = [...new Set(PHRASES.map((p) => normalize(p).trim()))].sort((a, b) => b.length - a.length);
const PHRASE_PATTERN = new RegExp(`(?:^| )(${PHRASE_ALTERNATIVES.join('|')})(?= |$)`, 'g');
const ACRONYM_PATTERN = new RegExp(`(?<![A-Za-z0-9])(${ACRONYMS.join('|')})(?![A-Za-z0-9])`, 'g');

/** The terms of the list found in the text, each once; empty when none (offer filtered out). */
export function matchedItKeywords(text: string): string[] {
  const found = new Set<string>();
  for (const match of ` ${normalize(text)} `.matchAll(PHRASE_PATTERN)) found.add(match[1]);
  for (const match of text.matchAll(ACRONYM_PATTERN)) found.add(match[1]);
  return [...found];
}
