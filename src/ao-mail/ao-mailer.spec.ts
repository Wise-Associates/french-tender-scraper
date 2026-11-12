import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explainSmtpError, isMessageRejection, parseMailConfig } from './ao-mailer';

// Fictitious settings.
const valid = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_USER: 'veille@acme.test',
  SMTP_PASSWORD: 'not-a-real-password',
  MAIL_FROM: 'Veille <veille@acme.test>',
  OFFERS_TO: 'ao@acme.test',
};

describe('parseMailConfig', () => {
  it('accepts complete settings and defaults to port 587', () => {
    assert.equal(parseMailConfig(valid).SMTP_PORT, 587);
  });

  it('names every missing variable without printing any value', () => {
    assert.throws(
      () => parseMailConfig({ ...valid, SMTP_PASSWORD: '', OFFERS_TO: undefined }),
      (err: Error) => /SMTP_PASSWORD/.test(err.message) && /OFFERS_TO/.test(err.message) && !/smtp\.example/.test(err.message),
    );
  });

  it('refuses a sender outside the AO inbox domain, even behind a quoted display name', () => {
    assert.throws(() => parseMailConfig({ ...valid, MAIL_FROM: 'veille@other.test' }), /MAIL_FROM.*same domain/);
    assert.throws(() => parseMailConfig({ ...valid, MAIL_FROM: '"Veille <x@acme.test>" <x@other.test>' }), /MAIL_FROM/);
    assert.throws(() => parseMailConfig({ ...valid, MAIL_FROM: 'a@acme.test, b@acme.test' }), /MAIL_FROM/);
  });

  it('accepts a sender written in capitals', () => {
    assert.equal(parseMailConfig({ ...valid, MAIL_FROM: 'VEILLE@ACME.TEST' }).MAIL_FROM, 'VEILLE@ACME.TEST');
  });

  it('refuses ports other than 587 and 465', () => {
    assert.throws(() => parseMailConfig({ ...valid, SMTP_PORT: '25' }), /SMTP_PORT/);
  });
});

describe('explainSmtpError', () => {
  it('points to the setting to fix', () => {
    assert.match(String(explainSmtpError({ code: 'EAUTH', message: '535 auth failed' })), /SMTP_USER and SMTP_PASSWORD/);
    assert.match(String(explainSmtpError({ command: 'MAIL FROM', message: '550 not allowed' })), /MAIL_FROM/);
    assert.match(String(explainSmtpError({ responseCode: 451, message: 'limit' })), /Temporary refusal/);
  });

  it('reports a temporary refusal as such, even at the login or sender step', () => {
    assert.match(String(explainSmtpError({ command: 'MAIL FROM', responseCode: 451, message: '451 too many' })), /Temporary refusal/);
    assert.match(String(explainSmtpError({ code: 'EAUTH', responseCode: 454, message: '454 try later' })), /Temporary refusal/);
  });
});

describe('isMessageRejection', () => {
  it('is true only for a permanent refusal of the message itself', () => {
    assert.equal(isMessageRejection({ code: 'EMESSAGE', responseCode: 554 }), true);
    assert.equal(isMessageRejection({ code: 'EMESSAGE', responseCode: 451 }), false);
    assert.equal(isMessageRejection({ code: 'EAUTH', responseCode: 535 }), false);
    assert.equal(isMessageRejection(new Error('connection lost')), false);
  });
});
