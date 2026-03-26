//Models
import File from "../../../models/files.js";

/**
 * @Description get all received files
 * @Route GET  api/received/all
 * @Access Private
 */
export const getReceivedFiles = async (req, res) => {
    const { email } = req.user;
    console.log(email);
    const { search } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    if (!email) {
        return res.status(401).json({
            status: false,
            msg: "Unauthorized: No email found in token"
        });
    }

    try {
        let query = { recevierEmails: email };

        if (search) {
            query["files.name"] = { $regex: search, $options: "i" };
        }

        const receivedFiles = await File.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await File.countDocuments(query);

        if (!receivedFiles || receivedFiles.length === 0) {
            return res.status(404).json({
                status: false,
                msg: "No files found"
            });
        }

        return res.status(200).json({
            status: true,
            data: receivedFiles,
            pagination: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}

/**
 * @Description Get Specific Received File
 * @Route GET  api/received/specific/:id
 * @Access Private
 */
export const getSpecificReceivedFile = async (req, res) => {
    const { id } = req.params;
    const email = req.user?.email;

    if (!email) {
        return res.status(401).json({
            status: false,
            msg: "Unauthorized"
        });
    }

    try {
        const file = await File.findOne({ _id: id });
        if (!file) {
            return res.status(404).json({
                status: false,
                msg: "File not found"
            });
        }
        if (!file.recevierEmails.includes(email)) {
            return res.status(403).json({
                status: false,
                msg: "You are not authorized to access this file"
            });
        }
        return res.status(200).json({
            status: true,
            data: file
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}

/**
 * @Description Delete Received File
 * @Route DELETE  api/received/:id
 * @Access Private
 */
export const deleteReceivedFile = async (req, res) => {
    const { id } = req.params;
    const email = req.user?.email;

    if (!email) {
        return res.status(401).json({
            status: false,
            msg: "Unauthorized"
        });
    }

    try {
        const file = await File.findOne({ _id: id });
        if (!file) {
            return res.status(404).json({
                status: false,
                msg: "File not found"
            });
        }
        if (!file.recevierEmails.includes(email)) {
            return res.status(403).json({
                status: false,
                msg: "You are not authorized to access this file"
            });
        }
        return res.status(200).json({
            status: true,
            msg: "File deleted successfully"
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}