import express from "express";
import { 
    sendFile, 
    generateUploadUrls,
    getTransfer, 
    initiateMultipartUpload,
    getPartUploadUrl,
    getPartUploadUrls,
    completeMultipartUpload,
    abortMultipartUpload,
    verifyPassword,
    deleteTransfer,
    streamVideo,
    speedTest
} from "../controllers/transfer/transfer.js";
import { optionalVerifyUser } from "../middlewares/verifyUser.js";

const router = express.Router();

router.use(optionalVerifyUser);
router.post("/send", sendFile);
router.post("/generate-upload-urls", generateUploadUrls);

 // Multipart Upload Routes
router.post("/initiate-multipart", initiateMultipartUpload);
router.post("/get-part-url", getPartUploadUrl);
router.post("/get-part-urls", getPartUploadUrls);
router.post("/complete-multipart", completeMultipartUpload);
router.post("/abort-multipart", abortMultipartUpload);

// Password & Deletion
router.post("/verify-password/:shortId", verifyPassword);
router.delete("/delete/:id", deleteTransfer);

router.get("/get-transfer/:shortId", getTransfer);

// Stream Routes
router.get("/stream/:shortId", streamVideo);

// Speed Test Route
router.all("/speed-test",express.raw({ type: '*/*', limit: '200mb' }), speedTest);


export default router;

