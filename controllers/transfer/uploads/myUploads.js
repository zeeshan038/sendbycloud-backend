import File from "../../../models/files.js";

/**
 * @Description Get all uploads 
 * @Route GET  api/uplaods/all
 * @Access Private
 */
export const getAllUploads = async (req, res) => {
    const userId = req.user?._id;
    const { search } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    if (!userId) {
        return res.status(401).json({
            status: false,
            msg: "Unauthorized: No user found in token"
        });
    }

    try {
        let query = { user: userId };
        if (search) {
            query["files.name"] = { $regex: search, $options: "i" };
        }
        const files = await File.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean()
            .exec();

        const totalFiles = await File.countDocuments(query);

        return res.status(200).json({
            status: true,
            msg: "Files fetched successfully",
            data: files,
            totalFiles,
            page,
            limit
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}

/**
 * @Description Get Specific Upload 
 * @Route GET  api/uplaods/specific/:id
 * @Access Private
 */
export const getSpecificUpload = async (req, res) => {
    const { fileId } = req.params;
    const userId = req.user?._id || req.user?.id;

    try {
        const file = await File.findOne({ _id: fileId, user: userId });
        if (!file) {
            return res.status(404).json({
                status: false,
                msg: "File not found"
            })
        }
        res.status(200).json({
            status: true,
            msg: "File fetched successfully",
            data: file
        })
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        })
    }
}


/**
 * @Description delet file 
 * @Route GET  api/uplaods/delete/:id
 * @Access Private
 */
export const deleteFile = async (req, res) => {
    const userId = req.user?._id || req.user?.id;
    const { fileId } = req.params;

    try {
        const file = await File.findOne({ _id: fileId, user: userId });
        if (!file) {
            return res.status(404).json({
                status: false,
                msg: "File not found"
            })
        }
        await file.deleteOne();
        res.status(200).json({
            status: true,
            msg: "File deleted successfully"
        })
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        })
    }
}