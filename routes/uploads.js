import express from "express";
import { getAllUploads, getSpecificUpload, deleteFile } from "../controllers/transfer/uploads/myUploads.js";
import { verifyUser } from "../middlewares/verifyUser.js";

const router = express.Router();

router.use(verifyUser);

router.get("/all", getAllUploads);
router.get("/specific/:fileId", getSpecificUpload);
router.delete("/delete/:fileId", deleteFile);

export default router;
