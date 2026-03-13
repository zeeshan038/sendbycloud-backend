import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
const app = express();


//CORS
app.use(cors(
  {
    origin: "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  }
));

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
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Your app is running on PORT ${PORT}`);
});
