# ADR 0007 — Read and attach the documents of Partenaire GC offers

- Status: accepted
- Date: 2026-11-21

## Context

Many Partenaire GC offers put the mission in their documents, not on the page:
the mission text often reads « CF. CDC joint ». The analysis (ADR 0001) judged
such offers on their title alone, and the AO inbox email (ADR 0002) carried no
documents. MyBestConsultant cannot fetch them: the documents are private files
of the subscriber area (`/system/files/…`), and MyBestConsultant has no session
(partenaire-gc.com is in its list of sites it never reads). The scraper has the
session, opened by hand (ADR 0003).

Sample of November 2026: each detail page has a « Documents » block
(`.field--name-field-documents`) with 1 to 3 files, mostly Word (.docx) and
some PDF, 15 to 200 KB: a cahier des charges, an annex to fill, and for some
buyers (Fastor GIE) a CV template filled with a sample CV.

Wise Associates asked for the documents in MyBestConsultant and in the
analysis, **without any change to MyBestConsultant**.

## Decision

- **Links**: only the page's « Documents » block, only `https://partenaire-gc.com/system/files/…`
  (the session cookie is never sent elsewhere), at most 5 per offer
  (`documentLinks`, `src/documents/offer-documents.ts`). Names come from the URL,
  decoded and reduced to safe characters.
- **Download** (`src/documents/document-download.ts`): Node `fetch` with the
  cookies Playwright gives for that URL (`context.cookies(url)`) and the
  browser's user agent; redirects not followed (a redirect or 401/403 means the
  session expired: the offer's other documents are not requested), 30 s, 10 MB
  checked while reading. The format is decided from the name (spreadsheets and
  unknown formats are not downloaded) and checked against the first bytes (a
  login page saved as « .pdf » is refused).
- **Analysis** (`readDocumentsForAnalysis`): when a detail page is read, its
  documents are downloaded and their text extracted **in memory**, nothing
  kept: PDF with `unpdf` (pdf.js, 40 pages at most), .docx with `fflate` and a
  linear reader of `word/document.xml`. The keyword filter and the model
  (Claude, or OpenAI during a credit problem) receive title, mission text and
  document text, contact details masked, 30,000 characters of documents at
  most. A page without mission text is analysed from its documents.
- **Parsing in a child process** (`extractTextIsolated`, `document-text.ts`):
  pdf.js does not bound how far it inflates a stream (a 1 MB PDF reached
  2.2 GB in the security review), and a .docx lying about its size keeps
  fflate busy for about a minute. Each document is read by a child Node
  process (V8 heap 256 MB, killed after 20 s) that marks itself as the first
  process the kernel kills when the container runs out of memory
  (`/proc/self/oom_score_adj`). A bad file becomes « illisible » for that
  document; the API, its scheduler and Chromium keep running (measured: a
  510 KB PDF inflating to 512 MB, child killed at the limit, API event loop
  delayed by 3 ms).
- **Texts in the prompt**: their « < » become « ‹ » (`framed`), so a document
  cannot close its `<document>` frame (nor the mission text its `<offre>`) and
  pose as instructions. The email-masking expression has bounded repetitions:
  it took seconds on a 30,000-letter document.
- **A document that cannot be read** (`DocumentFailure`, `documentsReadOutcome`):
  left out on purpose or for good (spreadsheet, CV template, 404, over 10 MB,
  unreadable file) → the offer is analysed without it; refused or redirected
  (expired session) → the session is checked again on the subscriber home
  page: expired, the run stops with the usual session alert; still valid,
  that file is left out (« refusé par le site alors que la session est
  valide ») and the offer goes on; timeout,
  network or server error → the offer is read again next run, without
  counting an attempt. Otherwise an offer whose page only says « see the
  attached cahier des charges » would be judged without it after a mere
  timeout and set aside for good.
- **Storage**: only the links (name, URL) of relevant offers, in
  `tender_documents`, written with the analysis.
- **Email** (`readDocumentsForEmail`): when a relevant offer is emailed, its
  documents are downloaded again with the session and attached — text formats
  only (PDF, Word, ODT, RTF, PowerPoint), 10 MB in all. The email lists the
  attached files (« Documents joints ») and the others with the reason
  (« Documents non joints »). A document that cannot be fetched, an expired
  session included, does not hold the offer back. `npm run ao:send` does the
  same through the API's browser code, without starting the API.
- **Not attached on purpose**:
  - spreadsheets: MyBestConsultant reads an attached spreadsheet as a table of
    offers (its `spreadsheet.ts`), so a matrix could become fake offers;
  - CV templates (`isCvTemplate`: « matrice … cv », « modèle … cv »…): their
    sample CV would pass for the offer's requirements, in our analysis and in
    MyBestConsultant's reading of the email. Neither is downloaded; both stay
    on the offer's page.

## Dependencies

- `unpdf` 1.9.1 (MIT, UnJS, no dependencies; bundles pdf.js without `eval`).
  It is an ES module: this CommonJS project loads it with `require()`, which
  Node supports from 22.12 (an ExperimentalWarning on Node 22, none on the
  image's Node 26); its types are declared in `src/documents/unpdf.d.ts`.
  1.9.1 is the last version declaring Node ≥ 22 (2.x needs Node 24).
- `fflate` 0.8.3 (MIT, no dependencies), the version MyBestConsultant uses. It
  never inflates past the size an archive declares, and that size is capped at
  20 MB: a .docx « zip bomb » cannot take more.

Not chosen: sending the PDF to Claude as a document block (no masking of the
contact details it contains, no Word support, OpenAI fallback different);
`pdf-parse` 1.x (unmaintained, old pdf.js with known flaws); `mammoth` (many
dependencies for what one XML part gives).

## Consequences

- One request per document when an offer is first read (most offers), and
  again for relevant offers when they are emailed, with the usual delay
  between requests.
- More text per Claude call (up to about 8,000 tokens of documents). The
  documents of the sample gave 1,000 to 7,000 characters.
- Partenaire GC's documents (confidential cahiers des charges) are copied
  into the AO inbox. Like the offer texts (ADR 0002), this must be covered by
  Wise Associates' agreement with Partenaire GC.
- Offers analysed before this change have no stored links: they are emailed
  without documents.
- A scanned PDF has no text: it is attached, not analysed.
  MyBestConsultant reads it with its own vision model.
- The attached files keep the buyers' contact details (names, emails,
  phones of the client's buyers): only the texts sent to the models and
  stored here are masked. They reach the AO inbox, where MyBestConsultant
  keeps AO emails 365 days, like the tenders buyers email it directly. To be
  recorded in Wise Associates' register of processing (RGPD).
- One child process is started per PDF or Word document read (about 100 ms
  each).
- A document that keeps failing temporarily (the site always answers 503 for
  it) keeps its offer waiting, as a detail page that keeps failing already does.
