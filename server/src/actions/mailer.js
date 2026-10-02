import nodemailer from 'nodemailer';
import { config } from '../config.js';

let mailer;
/** Uses SMTP_URL when set; otherwise a JSON transport that just logs, so dev needs no mail server. */
export function getMailer() {
  if (!mailer) {
    mailer = config.smtpUrl
      ? nodemailer.createTransport(config.smtpUrl)
      : nodemailer.createTransport({ jsonTransport: true });
  }
  return mailer;
}
