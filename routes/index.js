import express from "express";
const router = express.Router();


import userRouter from "./user.js";
import uploadRouter from "./upload.js";
import transferRouter from "./transfer.js";
import downloadRouter from "./download.js";

router.use("/user", userRouter);
router.use("/upload", uploadRouter);
router.use("/transfer", transferRouter);
router.use("/download", downloadRouter);

export default router;