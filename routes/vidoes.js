import express from 'express';

import {
    getAllVideos,
    getSpecificVideo,
    deleteVideo
} from '../controllers/videos/myVideos.js';
import { verifyUser } from '../middlewares/verifyUser.js';

const router = express.Router();

router.use(verifyUser);

router.get('/all', getAllVideos);
router.get('/specific/:id', getSpecificVideo);
router.delete('/delete/:id', deleteVideo);

export default router; 