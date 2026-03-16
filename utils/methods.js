//NPM Packages
import jwt from "jsonwebtoken";


export const generateToken = (user) => {
    return jwt.sign({ user }, process.env.JWT_SECRET, { expiresIn: "1h" });
};

export const sanitizeFileName = (fileName) => {
    return fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
};