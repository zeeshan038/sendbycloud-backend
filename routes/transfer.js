import express from "express";
import { 
    sendFile, 
    generateUploadUrls,
    getTransfer, 
    getDownloadUrl,
    initiateMultipartUpload,
    getPartUploadUrl,
    completeMultipartUpload,
    abortMultipartUpload,
    verifyPassword,
    deleteTransfer,
    streamVideo
} from "../controllers/transfer/transfer.js";

const router = express.Router();

router.post("/send", sendFile);
router.post("/generate-upload-urls", generateUploadUrls);

// Multipart Upload Routes
router.post("/initiate-multipart", initiateMultipartUpload);
router.post("/get-part-url", getPartUploadUrl);
router.post("/complete-multipart", completeMultipartUpload);
router.post("/abort-multipart", abortMultipartUpload);

// Password & Deletion
router.post("/verify-password/:shortId", verifyPassword);
router.delete("/delete/:id", deleteTransfer);

router.get("/get-transfer/:shortId", getTransfer);
router.get("/download/:shortId", getDownloadUrl);
router.get("/stream/:shortId", streamVideo);


export default router;
