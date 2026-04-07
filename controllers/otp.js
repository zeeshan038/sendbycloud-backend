import OTP from "../models/OTP.js";
import { sendEmail } from "../utils/Nodemailer.js";
import jwt from "jsonwebtoken";

/**
 * @Description Send OTP to Email
 * @Route POST api/otp/send
 * @Access Public
 */
export const sendOTP = async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ status: false, msg: "Email is required" });
    }

    try {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await OTP.findOneAndUpdate(
            { email },
            { otp, createdAt: Date.now() },
            { upsert: true, new: true }
        );

        // Send Email
        const subject = "Verification Code - SendByCloud";
        const text = `Your verification code is: ${otp}. This code will expire in 5 minutes.`;
        const html = `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #2b3a8c;">Verify your email</h2>
                <p>A verification code has been sent to your email.</p>
                <div style="background: #f4f6f9; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2b3a8c;">${otp}</span>
                </div>
                <p>This code will expire in 5 minutes.</p>
                <p style="font-size: 12px; color: #777;">If you didn't request this code, please ignore this email.</p>
            </div>
        `;

        await sendEmail({ to: email, subject, text, html });

        return res.status(200).json({
            status: true,
            msg: "OTP sent successfully"
        });
    } catch (error) {
        console.error("Error sending OTP:", error);
        return res.status(500).json({
            status: false,
            msg: "Failed to send OTP"
        });
    }
};

/**
 * @Description Verify OTP
 * @Route POST api/otp/verify
 * @Access Public
 */
export const verifyOTP = async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) {
        return res.status(400).json({ status: false, msg: "Email and OTP are required" });
    }

    try {
        const otpRecord = await OTP.findOne({ email, otp });

        if (!otpRecord) {
            return res.status(400).json({
                status: false,
                msg: "Invalid or expired verification code"
            });
        }

        // Mark as verified instead of deleting immediately. 
        // This allows sendFile to check the DB directly if the token isn't passed.
        otpRecord.isVerified = true;
        await otpRecord.save();

        const verificationToken = jwt.sign(
            { email, type: 'transfer_verification' },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );

        return res.status(200).json({
            status: true,
            msg: "Verification successful",
            verificationToken
        });
    } catch (error) {
        console.error("Error verifying OTP:", error);
        return res.status(500).json({
            status: false,
            msg: "Failed to verify OTP"
        });
    }
};
