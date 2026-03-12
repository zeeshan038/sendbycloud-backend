//NPM Packages
import mongoose from "mongoose";

const connectDb = async () => {
  try {
    await mongoose.connect('mongodb://localhost:27017', {
      dbName: "sendbycloud"
    });
    console.log("Connection Created");
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
};


export default connectDb;