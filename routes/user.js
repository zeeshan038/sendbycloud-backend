import express from "express";

import {
    Register,
    Login,
    SignupWithFirebase,
    getUserStorage,
    changePassword
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

export default router; 