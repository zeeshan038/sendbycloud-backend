import express from "express";
import { createReport, getAllReports } from "../controllers/Report/Report.js";


const router = express.Router();

router.post("/create", createReport);
router.get("/all", getAllReports);

export default router;
