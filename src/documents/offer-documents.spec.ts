import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DocumentText,
  documentFormat,
  documentLinks,
  documentName,
  documentsForPrompt,
  documentsReadOutcome,
  documentsText,
  isCvTemplate,
  matchesFormat,
  MAX_DOCUMENTS_PER_OFFER,
} from './offer-documents';
import { minimalDocx, minimalPdf } from './test-documents';

const ORIGIN = 'https://partenaire-gc.com';
const PAGE = `${ORIGIN}/consultations/offre-fictive`;

describe('documentLinks', () => {
  it('keeps the private files of the site, resolved against the page', () => {
    assert.deepEqual(documentLinks(['/system/files/document/2026-11/cdc-fictif.pdf'], PAGE, ORIGIN), [
      { name: 'cdc-fictif.pdf', url: `${ORIGIN}/system/files/document/2026-11/cdc-fictif.pdf` },
    ]);
  });

  it('never follows a link that would send the session cookie elsewhere', () => {
    const hrefs = [
      'https://evil.example/system/files/a.pdf',
      'http://partenaire-gc.com/system/files/b.pdf',
      'https://partenaire-gc.com.evil.example/system/files/c.pdf',
      'https://user:pass@partenaire-gc.com/system/files/d.pdf',
      '//evil.example/system/files/e.pdf',
      '/node/12',
      '/sites/default/files/public.pdf',
      'javascript:alert(1)',
      'http://[bad',
    ];
    assert.deepEqual(documentLinks(hrefs, PAGE, ORIGIN), []);
  });

  it('removes duplicates and keeps at most MAX_DOCUMENTS_PER_OFFER', () => {
    const hrefs = ['/system/files/a.pdf', '/system/files/a.pdf#page=2', ...Array.from({ length: 8 }, (_, i) => `/system/files/d${i}.docx`)];
    const links = documentLinks(hrefs, PAGE, ORIGIN);
    assert.equal(links.length, MAX_DOCUMENTS_PER_OFFER);
    assert.deepEqual(links.slice(0, 2).map((l) => l.name), ['a.pdf', 'd0.docx']);
  });
});

describe('documentName', () => {
  const name = (path: string) => documentName(new URL(path, ORIGIN));

  it('decodes the file name and keeps accents', () => {
    assert.equal(name('/system/files/Cahier%20des%20charges%20%C3%A9t%C3%A9.docx'), 'Cahier des charges été.docx');
  });

  it('replaces characters unsafe in an attachment name or an email line', () => {
    assert.equal(name('/system/files/a%22%3Cb%3E%0D%0Abcc%3Ax.pdf'), 'a__b___bcc_x.pdf');
    assert.equal(name('/system/files/%E0%A4%A.pdf'), '_E0_A4_A.pdf');
  });

  it('never returns an empty name and keeps the extension of a long one', () => {
    assert.equal(name('/system/files/...'), 'document');
    const long = name(`/system/files/${'x'.repeat(300)}.docx`);
    assert.equal(long.length, 120);
    assert.ok(long.endsWith('.docx'));
  });
});

describe('documentFormat and matchesFormat', () => {
  it('accepts the text formats MyBestConsultant reads, case-insensitively', () => {
    assert.deepEqual(documentFormat('CDC.PDF'), { format: 'pdf' });
    assert.deepEqual(documentFormat('annexe.docx'), { format: 'docx' });
  });

  it('leaves spreadsheets and unknown formats out, with a reason for the email', () => {
    assert.match((documentFormat('matrice.xlsx') as { problem: string }).problem, /tableur/);
    assert.match((documentFormat('archive.zip') as { problem: string }).problem, /« zip » non pris en charge/);
    assert.match((documentFormat('sans-extension') as { problem: string }).problem, /non pris en charge/);
    assert.match((documentFormat('piege.constructor') as { problem: string }).problem, /non pris en charge/);
  });

  it('checks the first bytes, not the name: a login page saved as .pdf is refused', () => {
    assert.equal(matchesFormat('pdf', minimalPdf(['Texte'])), true);
    assert.equal(matchesFormat('docx', minimalDocx(['Texte'])), true);
    assert.equal(matchesFormat('pdf', Buffer.from('<!DOCTYPE html><form class="user-login-form">')), false);
    assert.equal(matchesFormat('docx', minimalPdf(['Texte'])), false);
    assert.equal(matchesFormat('pdf', Buffer.alloc(0)), false);
  });
});

describe('isCvTemplate', () => {
  it('recognises CV templates to fill, whatever the separators and accents', () => {
    for (const name of ['matrice_cv_fastor_gie-partenaire-gc_2026_7.docx', 'Modèle CV.docx', 'CV-template.docx', 'trame_CV_client.doc']) {
      assert.equal(isCvTemplate(name), true, name);
    }
  });

  it('keeps cahiers des charges and annexes, even when they mention a CV', () => {
    for (const name of ['cdc-atu-mo-fonctionnelle-ao-1357.pdf', 'annexe-transactis-a-remplir_0-14.docx', 'CV_attendu_et_cdc.pdf', 'matrice-des-competences.docx', 'cvtheque.pdf']) {
      assert.equal(isCvTemplate(name), false, name);
    }
  });
});

describe('documentsReadOutcome', () => {
  const read = { name: 'cdc.pdf', url: 'u', text: 'Mission' };
  const problem = (failure: 'final' | 'temporary' | 'session', name = 'x.pdf') => ({ name, url: 'u', problem: `p-${failure}`, failure });

  it('goes on when every document was read or left out for good', () => {
    assert.deepEqual(documentsReadOutcome([]), { kind: 'ok' });
    assert.deepEqual(documentsReadOutcome([read, problem('final')]), { kind: 'ok' });
  });

  it('retries the offer next run after a passing failure, rather than judge it without its document', () => {
    assert.deepEqual(documentsReadOutcome([read, problem('final'), problem('temporary', 'cdc2.pdf')]), {
      kind: 'retry',
      name: 'cdc2.pdf',
      problem: 'p-temporary',
    });
  });

  it('reports an expired session first, whatever the other documents', () => {
    assert.deepEqual(documentsReadOutcome([problem('temporary'), problem('session')]), { kind: 'session', problem: 'p-session' });
  });
});

describe('documentsForPrompt', () => {
  const mask = (text: string) => text.replace(/\S+@\S+/g, '[email masqué]');
  const docs: DocumentText[] = [
    { name: 'cdc.pdf', url: `${ORIGIN}/system/files/cdc.pdf`, text: 'Développeur Java. Contact : rh@acme.test' },
    { name: 'annexe"<x>.docx', url: `${ORIGIN}/system/files/annexe.docx`, problem: 'accès refusé', failure: 'session' },
    { name: 'vide.pdf', url: `${ORIGIN}/system/files/vide.pdf`, text: '  ' },
  ];

  it('frames each document, masks contact details and says which could not be read', () => {
    const prompt = documentsForPrompt(docs, mask);
    assert.match(prompt, /<document nom="cdc.pdf">\nDéveloppeur Java\. Contact : \[email masqué\]\n<\/document>/);
    assert.doesNotMatch(prompt, /rh@acme/);
    assert.match(prompt, /<document nom="annexex.docx">\(non lu : accès refusé\)<\/document>/);
    assert.match(prompt, /<document nom="vide.pdf">\(aucun texte lisible\)<\/document>/);
  });

  it('cuts the documents at the limit, across documents, with a visible marker', () => {
    const long: DocumentText[] = [
      { name: 'a.pdf', url: 'u', text: 'a'.repeat(30) },
      { name: 'b.pdf', url: 'u', text: 'b'.repeat(30) },
    ];
    const prompt = documentsForPrompt(long, (t) => t, 40);
    assert.match(prompt, /<document nom="a.pdf">\na{30}\n<\/document>/);
    assert.match(prompt, /<document nom="b.pdf">\nb{10}\n\[… document tronqué\]\n<\/document>/);
  });

  it('adds nothing without documents', () => {
    assert.equal(documentsForPrompt([], mask), '');
    assert.equal(documentsText(docs), 'Développeur Java. Contact : rh@acme.test\n\n  ');
  });
});
