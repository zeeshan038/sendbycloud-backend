import 'dotenv/config';
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

console.log(`Checking SMTP connection to ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}...`);

transporter.verify((error, success) => {
  if (error) {
    console.error("SMTP Connection Error:", error);
    console.log("\nDIAGNOSIS:");
    console.log(`1. Your host ${process.env.SMTP_HOST} might be incorrect.`);
    console.log(`2. If you are seeing an IP like 192.168.x.x, it's a private IP and likely unreachable.`);
    console.log(`3. Check if your firewall or network is blocking port ${process.env.SMTP_PORT}.`);
  } else {
    console.log("SMTP Server is ready to take our messages!");
  }
  process.exit();
});
