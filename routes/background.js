import express from 'express';
import { createBackground, getAllBackgrounds, updateStatus, deleteBg, generateBackgroundUploadUrl, viewBackground } from '../controllers/Background/background.js';
import { verifyUser } from '../middlewares/verifyUser.js';
const router = express.Router();

router.get(/^\/view\/(.+)/, viewBackground);

router.use(verifyUser)
router.post('/generate-upload-url', generateBackgroundUploadUrl);
router.post('/create', createBackground);
router.get('/all', getAllBackgrounds);
router.delete('/delete/:bgId', deleteBg);
router.put('/update-status/:bgId', updateStatus);

export default router;