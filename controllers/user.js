import User from "../models/User.js";
import { RegisterSchema, LoginSchema } from "../schema/User.js";
import { generateToken, claimTransfersByEmail } from "../utils/methods.js";
import { auth } from "../config/firebase.js";
import bcrypt from "bcryptjs";

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
      return res.status(400).json({ status: false, msg: "Email not provided by provider" });
    }

    // Check if user exists
    let user = await User.findOne({ email });

    if (!user) {
      // Create new user if not found
      user = await User.create({
        name: name || email.split("@")[0], // Fallback if name is missing
        email,
        profilePicture: picture || "",
        firebaseUid: uid,
      });
    } else {
      if (!user.firebaseUid) {
        user.firebaseUid = uid;
        await user.save();
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