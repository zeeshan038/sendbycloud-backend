import express from "express";
const router = express.Router();


import userRouter from "./user.js";
import uploadRouter from "./upload.js";
import transferRouter from "./transfer.js";

router.use("/user", userRouter);
router.use("/upload", uploadRouter);
router.use("/transfer", transferRouter);

export default router;