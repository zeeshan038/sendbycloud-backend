import express from 'express';
const router = express.Router();

import {
    getReceivedFiles,
    getSpecificReceivedFile,
    deleteReceivedFile
} from '../controllers/transfer/recivedFiles/myReceived.js';
import { optionalVerifyUser } from '../middlewares/verifyUser.js';

router.use(optionalVerifyUser);

router.get("/all", getReceivedFiles);
router.get('/specific/:id', getSpecificReceivedFile);
router.delete('/delete/:id', deleteReceivedFile);

export default router;