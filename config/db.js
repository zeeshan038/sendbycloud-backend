//NPM Packages
import mongoose from "mongoose";

const connectDb = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connection Created");
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
};


export default connectDb;