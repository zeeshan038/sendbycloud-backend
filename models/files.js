import mongoose from "mongoose";
import { nanoid } from "nanoid";

const fileSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    senderEmail: {
        type: String
    },
    recevierEmails: {
        type: [String]
    },
    files: {
        type: [mongoose.Schema.Types.Mixed]
    },
    totalSize: {
        type: Number
    },
    uploadType: {
        type: String,
        enum: ["File", "Folder", "Videos"],
        default: "File",
    },
    password: {
        type: String,
    },
    expireDate: {
        type: Date,
    },
    downloadLimit: {
        type: Number,
    },
    downloadCount: {
        type: Number,
        default: 0,
    },
    message: {
        type: String,
        default: "",
    },
    expireIn: {
        type: String,
        enum: ["1d",
            "3d",
            "7d",
            "14d",
            "30d",
            "unlimited",
            "1 Day",
            "2 Days",
            "3 Days",
            "4 Days",
            "5 Days",
            "6 Days",
            "7 Days",
            "1 Month",
            "2 Months",
            "3 Months",
            "4 Months",
            "5 Months",
            "6 Months",
            "1 Year",
            "2 Years",
            "3 Years",
            "4 Years",
            "5 Years",
            "6 Years",
            "7 Years",
            "8 Years",
            "9 Years",
            "10 Years"
        ],
        default: "7d",
    },
    background: {
        type: String,
    },
    backgroundType: {
        type: String,
    },
    backgroundLink: {
        type: String,
    },
    selfDestruct: {
        type: Boolean,
        default: false,
    },
    isDownloadAble: {
        type: Boolean,
        default: false
    },
    shortId: {
        type: String,
        default: () => nanoid(8),
        unique: true,
        index: true
    },
    zipKey: {
        type: String,
        required: false,
    },
    status: {
        type: String,
        enum: ["active", "destroyed"],
        default: "active"
    }
}, { timestamps: true })

const File = mongoose.model("File", fileSchema);
export default File;