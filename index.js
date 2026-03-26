import "dotenv/config";
import express from "express";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION! 💥 Shutting down...");
  console.error(err.name, err.message, err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION! 💥 Shutting down...");
  console.error(err.name, err.message, err.stack);
  process.exit(1);
});
import cors from "cors";

import { startCleanupJob } from "./utils/cleanup.js";

const app = express();
startCleanupJob();

// Log incoming request origin
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url} | Origin: ${req.headers.origin || "None"}`);
  next();
});

const allowedOrigins = [
  "http://localhost:5173",
  "https://sendbycloud.com",
  "https://app.sendbycloud.com"
].filter(Boolean);

app.use(cors(
  {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  }
));

app.get("/api/health", (req, res) => {
  res.status(200).json({ status: true, msg: "Server is healthy and CORS is working" });
});

//Project files and routes
import connectDb from "./config/db.js";
import "./config/firebase.js";
import apiRouter from "./routes/index.js";

// Middlewares
app.use(express.json({ limit: "500mb" }));

//connect to database 
connectDb(); 

//Connecting routes
app.use("/api", apiRouter);

//Connect Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Your app is running on PORT ${PORT}`);
});
 