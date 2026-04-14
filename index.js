import "dotenv/config";
import express from "express";
import cors from "cors";
import { startCleanupJob } from "./utils/cleanup.js";
import connectDb from "./config/db.js";
import "./config/firebase.js";
import apiRouter from "./routes/index.js";

const app = express();
startCleanupJob();

const allowedOrigins = [
  "http://localhost:5173",
  "https://sendbycloud.com",
  "https://app.sendbycloud.com",
  "https://sbc-testing.vercel.app"
].filter(Boolean);


app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Range"],
  exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
  optionsSuccessStatus: 204
}));

// 4. Body parser
app.use(express.json({ limit: "500mb" }));

// 5. Health check
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: true, msg: "Server is healthy and CORS is working" });
});

// 6. Database + Routes
connectDb();
app.use("/api", apiRouter);

// 7. Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Your app is running on PORT ${PORT}`);
});