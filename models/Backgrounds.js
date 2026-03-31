import mongoose from "mongoose";

const backgroundSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    name: {
        type: String,
        required: true
    },
    url: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ["image", "video"],
        required: true
    },
    link: {
        type: String,
        default: ""
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true })

const Background = mongoose.model("Background", backgroundSchema);
export default Background;