# ADR 0002 — Send relevant offers to MyBestConsultant's AO inbox

- Status: accepted (first test requested on 2026-11-12)
- Date: 2026-11-12

## Context

Offers that Claude matches to Wise Associates' categories (ADR 0001) must
reach MyBestConsultant, where the team qualifies and answers them. The veille
(veille-marches-emplois) already feeds MyBestConsultant through its AO inbox:
one offer per email, read by MyBestConsultant's AI, which expects specific
labels and recognises the veille by an email header from the organisation's
own domain.

## Decision

- Reuse the veille's channel and format: one offer per email to `OFFERS_TO`,
  labels « Intitulé », « Client », « Lieu », « Date limite de réponse »,
  headers `X-Wise-Veille: scraping` and `X-Wise-Veille-Source: partenaire-gc`,
  sender on the same domain as the inbox (checked at startup of the command).
- SMTP settings with the veille's variable names and connection settings
  (STARTTLS required, one message per second, 10 messages per connection),
  nodemailer 10.1.7 as in the veille.
- Sending is a command (`npm run ao:send -- --limit N`, with `--dry-run`), not
  an API route: the API has no authentication. `--limit` is mandatory.
- Delivery is at least once: an offer is recorded in `tender_ao_emails` only
  after the SMTP server accepted it; a crash in between re-sends it, and
  MyBestConsultant merges the duplicate (fingerprint). One sending run at a
  time (lock file). A message refused for its content is skipped, as in the
  veille, so it cannot block the next offers. Offers past their deadline are
  skipped (MyBestConsultant ignores them anyway).
- Links in the email point only to partenaire-gc.com (phishing from an altered
  listing), and the sender's address is read with nodemailer's own parser.
- The email body is the mission text stored for relevant offers, with emails
  and phone numbers masked (ADR 0001).

## Consequences

- Partenaire GC's paid offer texts are copied into MyBestConsultant. Like the
  scraping itself, this must be covered by Wise Associates' agreement with
  Partenaire GC.
- Person names that appear in a mission text reach the AO inbox (only contact
  details are masked).
- Sending is manual for now; running it after each scrape is a later decision.
