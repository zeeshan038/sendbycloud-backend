import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const optionalVerifyUser = async (req, res, next) => {
  req.user = null;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token.trim(), process.env.JWT_SECRET);
    const userId = decoded.user?._id;

    if (!userId) return next();

    req.user = await User.findById(userId).select("-password");
    return next();
  } catch {
    req.user = null;
    return next();
  }
};