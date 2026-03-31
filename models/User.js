import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
   name: {
      type: String,
   },
   email: {
      type: String,
      required: true
   },
   password: {
      type: String,
      required: false,
      select: false
   },
   firebaseUid: {
      type: String,
      required: false
   },
   profilePicture: {
      type: String,
      default: ""
   },
   tier: {
      type: String,
      enum: ["free", "pro", "enterprise"],
      default: "free"
   },
   storage: {
      type: String,
      enum: ["7GB", "100GB", "1TB"],
      default: "7GB"
   },
   storageUsed: {
      type: Number,
      default: 0
   },
});

export default mongoose.model("User", userSchema); 