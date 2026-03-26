//NPM Packages
import mongoose from "mongoose";

const connectDb = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connection Created");
  } catch (error) {
    console.error("MongoDB Connection Error Details:", error);
    throw error;
  }
};


export default connectDb;