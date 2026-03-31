import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Verify SMTP connection
transporter.verify((error, success) => {
  if (error) {
    console.error("SMTP Connection Error:", error);
  } else {
    console.log("SMTP Server is ready to take our messages");
  }
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

  try {
    const info = await transporter.sendMail({
      from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
      attachments,
    });

    console.log("Email sent successfully:", info.messageId);
    console.log("Accepted:", info.accepted);
    console.log("Rejected:", info.rejected);
    console.log("Envelope:", info.envelope);
    return info;
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }

};

/**
 * Build the "file received" HTML email from the template.
 * @param {{ senderEmail: string, shareLink: string, fileCount?: number, totalSize?: string, expireDate?: string, clientUrl?: string }} data
 * @returns {string} populated HTML string
 */
export const buildFileReceivedHtml = (data) => {
  const templatePath = path.join(__dirname, "emailTemplates", "fileReceived.html");
  let html = fs.readFileSync(templatePath, "utf-8");

  const totalBytes = typeof data.totalSize === "number" ? data.totalSize : 0;
  const formattedSize =
    totalBytes > 0
      ? totalBytes >= 1_073_741_824
        ? `${(totalBytes / 1_073_741_824).toFixed(1)} GB`
        : totalBytes >= 1_048_576
          ? `${(totalBytes / 1_048_576).toFixed(1)} MB`
          : `${(totalBytes / 1024).toFixed(1)} KB`
      : "N/A";

  const expireDate = data.expireDate
    ? new Date(data.expireDate).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    : "N/A";

  const replacements = {
    "{{SENDER_EMAIL}}": data.senderEmail || "Unknown",
    "{{SENDER_INITIAL}}": (data.senderEmail || "?")[0].toUpperCase(),
    "{{SHARE_LINK}}": data.shareLink || "#",
    "{{FILE_COUNT}}": String(data.fileCount ?? 1),
    "{{TOTAL_SIZE}}": formattedSize,
    "{{EXPIRE_DATE}}": expireDate,
    "{{CLIENT_URL}}": data.clientUrl || process.env.CLIENT_URL || "#",
  };

  for (const [token, value] of Object.entries(replacements)) {
    html = html.replaceAll(token, value);
  }

  return html;
};

/**
 * Build the "file destroyed" HTML email from the template.
 * @param {{ shortId: string, fileCount?: number }} data
 * @returns {string} populated HTML string
 */
export const buildFileDestroyedHtml = (data) => {
  const templatePath = path.join(__dirname, "emailTemplates", "fileDestroyed.html");
  let html = fs.readFileSync(templatePath, "utf-8");

  const replacements = {
    "{{SHORT_ID}}": data.shortId || "Unknown",
    "{{FILE_COUNT}}": String(data.fileCount ?? 1),
  };

  for (const [token, value] of Object.entries(replacements)) {
    html = html.replaceAll(token, value);
  }

  return html;
};

export { transporter };
export default transporter;
