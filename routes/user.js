import express from "express";
import { Register, Login, SignupWithFirebase } from "../controllers/user.js";

const router = express.Router();

router.post("/register", Register);
router.post("/login", Login);

// Social Logins (Google, Microsoft, etc.)
router.post("/signupwithgoogle", SignupWithFirebase);
router.post("/signupwithmicrosoft", SignupWithFirebase);

export default router;