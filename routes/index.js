import express from "express";
const router = express.Router();


import userRouter from "./user.js";
import uploadRouter from "./uploads.js";
import transferRouter from "./transfer.js";
import downloadRouter from "./download.js";
import receivedRouter from "./received.js";
import videoRouter from "./vidoes.js";
import backgroundRouter from "./background.js";
import otpRouter from "./otp.js";

router.use("/user", userRouter);
router.use("/uploads", uploadRouter);
router.use("/transfer", transferRouter);
router.use("/download", downloadRouter);
router.use("/received", receivedRouter);
router.use('/videos',videoRouter);
router.use('/background',backgroundRouter);
router.use('/otp', otpRouter);

export default router; 