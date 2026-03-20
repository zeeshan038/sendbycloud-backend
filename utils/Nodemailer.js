import nodemailer from "nodemailer";

const port = Number(process.env.SMTP_PORT);
const secure =
  process.env.SMTP_SECURE !== undefined
    ? process.env.SMTP_SECURE === "true"
    : port === 465; // common: 465 uses TLS directly, 587 uses STARTTLS

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number.isFinite(port) ? port : 587,
  secure,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send an email (supports attachments).
 * - `attachments` can be a Nodemailer attachments array: [{ filename, path }] etc.
 */
export const sendEmail = async ({
  to,
  subject,
  text,
  html,
  attachments,
  from,
}) => {
  if (!process.env.SMTP_HOST) throw new Error("Missing SMTP_HOST");
  if (!process.env.SMTP_USER) throw new Error("Missing SMTP_USER");
  if (!process.env.SMTP_PASS) throw new Error("Missing SMTP_PASS");
  if (!process.env.SMTP_PORT) throw new Error("Missing SMTP_PORT");
  if (!to) throw new Error("Missing email recipient `to`");

  return transporter.sendMail({
    from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: subject || "",
    text,
    html,
    attachments,
  });
};

export { transporter };
export default transporter;
