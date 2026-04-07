import express from "express";

import {
    Register,
    Login,
    SignupWithFirebase,
    getUserStorage,
    changePassword,
    getSettings,
    toggle2FA,
    verifyToggle2FA,
    checkToggle,
 
} from "../controllers/user.js";
import { verifyUser } from "../middlewares/verifyUser.js";

const router = express.Router();

router.post("/register", Register);
router.post("/login", Login);

// Social Logins (Google, Microsoft, etc.)
router.post("/signupwithgoogle", SignupWithFirebase);
router.post("/signupwithmicrosoft", SignupWithFirebase);

router.use(verifyUser);
router.get("/storage", getUserStorage);
router.post("/change-password", changePassword);
router.get("/settings", getSettings);
router.post("/toggle-2fa", toggle2FA);
router.post("/verify-toggle-2fa", verifyToggle2FA);
router.get("/check-toggle-2fa", checkToggle);

export default router; 