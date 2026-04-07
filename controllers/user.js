import User from "../models/User.js";
import { RegisterSchema, LoginSchema } from "../schema/User.js";
import { generateToken, claimTransfersByEmail } from "../utils/methods.js";
import { auth } from "../config/firebase.js";
import bcrypt from "bcryptjs";
import { sendEmail, buildWelcomeEmailHtml } from "../utils/Nodemailer.js";
import File from "../models/files.js";
import OTP from "../models/OTP.js";

/**
 * @Descrition Register a new user
 * @Route POST /api/user/register
 * @Access Public
 */
export const Register = async (req, res) => {
  const payload = req.body;

  //Error Handling
  const result = RegisterSchema(payload);
  if (result.error) {
    const errors = result.error.details
      .map((detail) => detail.message)
      .join(",");
    return res.status(400).json({ msg: errors, status: false });
  }

  try {
    const userExist = await User.findOne({ email: payload.email });
    if (userExist) {
      return res
        .status(400)
        .json({ status: false, msg: "User already exists" });
    }
    const salt = await bcrypt.genSalt(10);
    const hashPassword = await bcrypt.hash(payload.password, salt);
    const user = await User.create({ ...payload, password: hashPassword });
    const token = generateToken(user);

    // [CLAIM] Link anonymous transfers to the new account
    await claimTransfersByEmail(user.email, user._id);

    // [EMAIL] Send welcome email
    try {
      const welcomeHtml = buildWelcomeEmailHtml({ userName: user.name });
      await sendEmail({
        to: user.email,
        subject: "Welcome to SendByCloud!",
        html: welcomeHtml,
      });
    } catch (emailError) {
      console.error("Error sending welcome email:", emailError.message);
      // We don't want to fail registration if email fails
    }


    return res
      .status(200)
      .json({
        status: true,
        msg: "User registered successfully",
        user,
        token,
      });
  } catch (error) {
    return res.status(500).json({
      status: false,
      msg: error.message,
    });
  }
};

/**
 * @Descrition Login a user
 * @Route POST /api/user/login
 * @Access Public
 */
export const Login = async (req, res) => {
  const payload = req.body;

  //Error Handling
  const result = LoginSchema(payload);
  if (result.error) {
    const errors = result.error.details
      .map((detail) => detail.message)
      .join(",");
    return res.status(400).json({ msg: errors, status: false });
  }

  try {
    const user = await User.findOne({ email: payload.email }).select("+password");
    if (!user) {
      return res
        .status(400)
        .json({ status: false, msg: "User not found" });
    }

    if (!user.password) {
      return res.status(400).json({
        status: false,
        msg: "This account was created via social login. Please login with Google or Microsoft."
      });
    }

    const isPasswordValid = await bcrypt.compare(payload.password, user.password);
    if (!isPasswordValid) {
      return res
        .status(400)
        .json({ status: false, msg: "Invalid password" });
    }

    // Check for 2FA
    if (user.isTwoFactorEnabled) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await OTP.findOneAndUpdate(
        { email: user.email },
        { otp, createdAt: Date.now() },
        { upsert: true, new: true }
      );

      // Send 2FA Email
      const twoFaHtml = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #2b3a8c;">Security Verification</h2>
            <p>Your login verification code is below. For your security, do not share this code.</p>
            <div style="background: #f4f6f9; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2b3a8c;">${otp}</span>
            </div>
            <p>This code will expire in 5 minutes.</p>
        </div>
      `;

      await sendEmail({
        to: user.email,
        subject: "Login Verification Code - SendByCloud",
        html: twoFaHtml
      });

      return res.status(200).json({
        status: true,
        isTwoFactorRequired: true,
        msg: "Two-Factor Authentication required"
      });
    }

    const token = generateToken(user);

    // [CLAIM] Link anonymous transfers just in case there are any
    await claimTransfersByEmail(user.email, user._id);

    return res
      .status(200)
      .json({
        status: true,
        msg: "User logged in successfully",
        user,
        token,
      });
  } catch (error) {
    return res.status(500).json({
      status: false,
      msg: error.message,
    });
  }
};

/**
 * @Descrition login or signup with Firebase (Google, Microsoft, etc.)
 * @Route POST /api/user/signupwithmicrosoft/google
 * @Access Public
 */
export const SignupWithFirebase = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ status: false, msg: "ID Token is required" });
  }

  try {
    // Verify Firebase ID Token (Works for Google, Microsoft, Apple, etc.)
    const decodedToken = await auth.verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    if (!email) {
      return res.status(400).json({
        status: false,
        msg: "Email not provided by provider"
      });
    }

    // Check if user exists
    let user = await User.findOne({ email });
    let isNewUser = false;

    if (!user) {
      // Create new user if not found
      user = await User.create({
        name: name || email.split("@")[0],
        email,
        profilePicture: picture || "",
        firebaseUid: uid,
      });
      isNewUser = true;
    } else {
      if (!user.firebaseUid) {
        user.firebaseUid = uid;
        await user.save();
      }
    }

    // [EMAIL] Send welcome email for new users
    if (isNewUser) {
      try {
        const welcomeHtml = buildWelcomeEmailHtml({ userName: user.name });
        await sendEmail({
          to: user.email,
          subject: "Welcome to SendByCloud!",
          html: welcomeHtml,
        });
      } catch (emailError) {
        console.error("Error sending welcome email:", emailError.message);
      }
    }

    const token = generateToken(user);

    // [CLAIM] Link anonymous transfers to the new or existing account
    await claimTransfersByEmail(user.email, user._id);


    return res.status(200).json({
      status: true,
      msg: "Social login successful",
      user,
      token,
    });
  } catch (error) {
    console.error("Firebase Auth Error:", error);
    return res.status(401).json({
      status: false,
      msg: "Invalid or expired token",
    });
  }
};


/**
 * @Description Get user storage details
 * @Route GET /api/user/storage
 * @Access Private
 */
export const getUserStorage = async (req, res) => {
  const { id } = req.user;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ status: false, msg: "User not found" });
    }
    return res.status(200).json({
      status: true,
      msg: "User storage details fetched successfully",
      storage: user.storageUsed,
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      msg: error.message,
    });
  }
};


/**
 * @Description Change Password
 * @Route GET /api/user/change-password
 * @Access Private
 */
export const changePassword = async (req, res) => {
  const { id } = req.user;
  const { currentPassword, newPassword, confirmPassword } = req.body;

  try {
    const user = await User.findById(id).select("+password");
    if (!user) {
      return res.status(404).json({ status: false, msg: "User not found" });
    }
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ status: false, msg: "Current Password is not valid" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ status: false, msg: "New Password and Confirm Password do not match" });
    }
    const salt = await bcrypt.genSalt(10);
    const hashPassword = await bcrypt.hash(newPassword, salt);
    user.password = hashPassword;
    await user.save();
    return res.status(200).json({
      status: true,
      msg: "Password changed successfully",
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      msg: error.message,
    });
  }
}


/**
 * @Description Settings Data
 * @Route GET /api/user/settings
 * @Access Private
 */
export const getSettings = async (req, res) => {
  const { id } = req.user;
  try {
    const user = await User.findById(id).select("tier storageUsed");
    if (!user) {
      return res.status(404).json({ status: false, msg: "User not found" });
    }

    // Auto-repair negative storage
    if (user.storageUsed < 0) {
      user.storageUsed = 0;
      await user.save();
    }

    const totalTransfers = await File.countDocuments({ user: id, status: "active" });
    const totalDestroyedTransfers = await File.countDocuments({ user: id, status: "destroyed" });

    return res.status(200).json({
      status: true,
      msg: "User settings fetched successfully",
      settings: {
        tier: user.tier,
        storageUsed: user.storageUsed,
        totalTransfers,
        totalDestroyedTransfers
      },
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      msg: error.message,
    });
  }
}


/**
 * @Description Request to toggle 2FA (Sends OTP)
 * @Route POST /api/user/toggle-2fa
 * @Access Private
 */
export const toggle2FA = async (req, res) => {
  const { id } = req.user;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ status: false, msg: "User not found" });
    }

    const action = user.isTwoFactorEnabled ? "disable" : "enable";

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await OTP.findOneAndUpdate(
      { email: user.email },
      { otp, createdAt: Date.now() },
      { upsert: true, new: true }
    );

    const emailHtml = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #2b3a8c;">Security Verification</h2>
            <p>You requested to ${action} Two-Factor Authentication on your account. Your verification code is below.</p>
            <div style="background: #f4f6f9; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2b3a8c;">${otp}</span>
            </div>
            <p>This code will expire in 5 minutes.</p>
        </div>
    `;

    await sendEmail({
      to: user.email,
      subject: `Verification Code to ${action} 2FA - SendByCloud`,
      html: emailHtml
    });

    return res.status(200).json({
      status: true,
      msg: `Verification code sent to email to ${action} 2FA.`,
      action
    });
  } catch (error) {
    return res.status(500).json({ status: false, msg: error.message });
  }
}

/**
 * @Description Verify OTP to toggle 2FA
 * @Route POST /api/user/verify-toggle-2fa
 * @Access Private
 */
export const verifyToggle2FA = async (req, res) => {
  const { id } = req.user;
  const { otp } = req.body;

  if (!otp) {
    return res.status(400).json({ status: false, msg: "OTP is required" });
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ status: false, msg: "User not found" });
    }

    const otpRecord = await OTP.findOne({ email: user.email, otp });
    if (!otpRecord) {
      return res.status(400).json({ status: false, msg: "Invalid or expired verification code" });
    }

    user.isTwoFactorEnabled = !user.isTwoFactorEnabled;
    await user.save();

    await OTP.deleteOne({ _id: otpRecord._id });

    return res.status(200).json({
      status: true,
      msg: `2FA has been successfully ${user.isTwoFactorEnabled ? "enabled" : "disabled"}`,
      isTwoFactorEnabled: user.isTwoFactorEnabled,
    });
  } catch (error) {
    return res.status(500).json({ status: false, msg: error.message });
  }
}

/**
 * @Description Check 2FA State
 * @Route GET /api/user/check-toggle
 * @Access Private
 */
export const checkToggle = async (req, res) => {
  const { id } = req.user;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ status: false, msg: "User not found" });
    }

    const is2FAEnabled = !!user.isTwoFactorEnabled;
    return res.status(200).json({
      status: true,
      msg: is2FAEnabled ? "2FA is enabled" : "2FA is disabled",
      is2FAEnabled,
    });
  } catch (error) {
    return res.status(500).json({ status: false, msg: error.message });
  }
}

/**
 * @Description Verify 2FA and Login
 * @Route POST /api/user/verify-2fa-login
 * @Access Public
 */
export const verify2FALogin = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ status: false, msg: "Email and OTP are required" });
  }

  try {
    const otpRecord = await OTP.findOne({ email, otp });
    if (!otpRecord) {
      return res.status(400).json({ status: false, msg: "Invalid or expired verification code" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: false, msg: "User not found" });
    }

    // Clean up OTP record
    await OTP.deleteOne({ _id: otpRecord._id });

    // Link anonymous transfers
    await claimTransfersByEmail(email, user._id);

    const token = generateToken(user);
    return res.status(200).json({
      status: true,
      msg: "Logged in successfully",
      user,
      token,
    });
  } catch (error) {
    return res.status(500).json({ status: false, msg: error.message });
  }
}