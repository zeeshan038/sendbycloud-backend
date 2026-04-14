
import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
    category: {
        type : String,
        required : true
    },
    name :{
        type : String,
        required : true
    },
    email :{
      type : String,
        required : true
    },
    company :{
        type : String,
        default : ""
    },
    subject :{
          type : String,
        default : ""
    },
    message :{
          type : String,
        default : ""
    },
    
},{
    timestamps : true
})

const Report = mongoose.model("Report", reportSchema);

export default Report;