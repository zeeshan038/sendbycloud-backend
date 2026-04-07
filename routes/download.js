import express from "express";
import { 
    getDownloadUrl, 
    startDownload, 
    completeDownload, 
    cancelDownload,
    getDownloadPartUrl,
    getAllDownloadPartUrls
} from "../controllers/transfer/download.js";

const router = express.Router();

router.post("/get-all-download-part-urls/:shortId", getAllDownloadPartUrls);
router.get("/download/:shortId", getDownloadUrl);
router.post("/download-part/:shortId", getDownloadPartUrl);
router.post("/download-start/:shortId", startDownload);
router.post("/download-complete/:shortId", completeDownload);
router.post("/download-cancel/:shortId", cancelDownload);

export default router;
