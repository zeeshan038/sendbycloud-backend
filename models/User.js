import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
   name : {
    type: String,
   },
   email : {
    type: String,
    required: true
   },
   password : {
    type: String,
    required: false
   },
   firebaseUid : {
    type: String,
    required: false
   },
   profilePicture : {
    type: String,
    default: ""
   }
});

export default mongoose.model("User", userSchema);